import execa from 'execa';
import { EOL } from 'os';

import { Context } from '../types';

import gitNoCommits from '../ui/messages/errors/gitNoCommits';
import gitNotInitialized from '../ui/messages/errors/gitNotInitialized';
import gitNotInstalled from '../ui/messages/errors/gitNotInstalled';

const newline = /\r\n|\r|\n/; // Git may return \n even on Windows, so we can't use EOL

export async function execGitCommand(command: string) {
  try {
    const { all } = await execa.command(command, {
      env: { LANG: 'C', LC_ALL: 'C' }, // make sure we're speaking English
      timeout: 10000, // 10 seconds
      all: true, // interleave stdout and stderr
      shell: true, // we'll deal with escaping ourselves (for now)
    });
    return all;
  } catch (error) {
    const { message } = error;

    if (message.includes('not a git repository')) {
      throw new Error(gitNotInitialized({ command }));
    }

    if (message.includes('git not found')) {
      throw new Error(gitNotInstalled({ command }));
    }

    if (message.includes('does not have any commits yet')) {
      throw new Error(gitNoCommits({ command }));
    }

    throw error;
  }
}

export async function getVersion() {
  const result = await execGitCommand(`git --version`);
  return result.replace('git version ', '');
}

// The slug consists of the last two parts of the URL, at least for GitHub, GitLab and Bitbucket,
// and is typically followed by `.git`. The regex matches the last two parts between slashes, and
// ignores the `.git` suffix if it exists, so it matches something like `ownername/reponame`.
export async function getSlug() {
  const result = await execGitCommand(`git config --get remote.origin.url`);
  const downcasedResult = result.toLowerCase();
  const [, slug] = downcasedResult.match(/([^/:]+\/[^/]+?)(\.git)?$/) || [];
  return slug;
}

// NOTE: At some point we should check that the commit has been pushed to the
// remote and the branch matches with origin/REF, but for now we are naive about
// adhoc builds.

// We could cache this, but it's probably pretty quick
export async function getCommit(revision = '') {
  const result = await execGitCommand(
    // Technically this yields the author info, not committer info
    `git --no-pager log -n 1 --format="%H ## %ct ## %ae ## %an" ${revision}`
  );
  const [commit, committedAtSeconds, committerEmail, committerName] = result.split(' ## ');
  const committedAt = Number(committedAtSeconds) * 1000;
  return { commit, committedAt, committerEmail, committerName };
}

export async function getBranch() {
  try {
    // Git v2.22 and above
    // Yields an empty string when in detached HEAD state
    const branch = await execGitCommand('git branch --show-current');
    return branch || 'HEAD';
  } catch (e) {
    try {
      // Git v1.8 and above
      // Throws when in detached HEAD state
      const ref = await execGitCommand('git symbolic-ref HEAD');
      return ref.replace(/^refs\/heads\//, ''); // strip the "refs/heads/" prefix
    } catch (ex) {
      // Git v1.7 and above
      // Yields 'HEAD' when in detached HEAD state
      const ref = await execGitCommand('git rev-parse --abbrev-ref HEAD');
      return ref.replace(/^heads\//, ''); // strip the "heads/" prefix that's sometimes present
    }
  }
}

export async function hasPreviousCommit() {
  const result = await execGitCommand(`git --no-pager log -n 1 --skip=1 --format="%H"`);
  return !!result.trim();
}

// Check if a commit exists in the repository
export async function commitExists(commit: string) {
  try {
    await execGitCommand(`git cat-file -e "${commit}^{commit}"`);
    return true;
  } catch (error) {
    return false;
  }
}

export async function getChangedFiles(baseCommit: string, headCommit = '') {
  // Note that an empty headCommit will include uncommitted (staged or unstaged) changes.
  const files = await execGitCommand(`git --no-pager diff --name-only ${baseCommit} ${headCommit}`);
  return files.split(newline).filter(Boolean);
}

/**
 * Returns a boolean indicating whether the workspace is up-to-date (neither ahead nor behind) with
 * the remote.
 */
export async function isUpToDate({ log }: Pick<Context, 'log'>) {
  execGitCommand(`git remote update`);

  let localCommit;
  try {
    localCommit = await execGitCommand('git rev-parse HEAD');
    if (!localCommit) throw new Error('Failed to retrieve last local commit hash');
  } catch (e) {
    log.warn(e);
    return true;
  }

  let remoteCommit;
  try {
    remoteCommit = await execGitCommand('git rev-parse "@{upstream}"');
    if (!remoteCommit) throw new Error('Failed to retrieve last remote commit hash');
  } catch (e) {
    log.warn(e);
    return true;
  }

  return localCommit === remoteCommit;
}

/**
 * Returns a boolean indicating whether the workspace is clean (no changes, no untracked files).
 */
export async function isClean() {
  const status = await execGitCommand('git status --porcelain');
  return status === '';
}

/**
 * Returns the "Your branch is behind by n commits (pull to update)" part of the git status message,
 * omitting any of the other stuff that may be in there. Note we expect the workspace to be clean.
 */
export async function getUpdateMessage() {
  const status = await execGitCommand('git status');
  return status
    .split(/(\r\n|\r|\n){2}/)[0] // drop the 'nothing to commit' part
    .split(newline)
    .filter((line) => !line.startsWith('On branch')) // drop the 'On branch x' part
    .join(EOL)
    .trim();
}

/**
 * Returns the git merge base between two branches, which is the best common ancestor between the
 * last commit on either branch. The "best" is defined by not having any descendants which are a
 * common ancestor themselves. Consider this example:
 *
 *   - A - M  <= main
 *      \ /
 *       B    <= develop
 *        \
 *         C  <= feature
 *
 * The merge base between main and feature is B, because it's the best common ancestor of C and M.
 * A is a common ancestor too, but it isn't the "best" one because it's an ancestor of B.
 *
 * It's also possible to have a situation with two merge bases, where there isn't one "best" option:
 *
 *   - A - M  <= main
 *      \ /
 *       x    (not a commit)
 *      / \
 *   - B - N  <= develop
 *
 * Here, both A and B are the best common ancestor between main and develop. Neither one is the
 * single "best" option because they aren't ancestors of each other. In this case we try to pick the
 * one on the base branch, but if that fails we just pick the first one and hope it works out.
 * Luckily this is an uncommon scenario.
 *
 * @param {string} headRef Name of the head branch
 * @param {string} baseRef Name of the base branch
 */
export async function findMergeBase(headRef: string, baseRef: string) {
  const result = await execGitCommand(`git merge-base --all ${headRef} ${baseRef}`);
  const mergeBases = result.split(newline).filter((line) => line && !line.startsWith('warning: '));
  if (mergeBases.length === 0) return undefined;
  if (mergeBases.length === 1) return mergeBases[0];

  // If we find multiple merge bases, look for one on the base branch.
  // If we don't find a merge base on the base branch, just return the first one.
  const branchNames = await Promise.all(
    mergeBases.map(async (sha) => {
      const name = await execGitCommand(`git name-rev --name-only --exclude="tags/*" ${sha}`);
      return name.replace(/~[0-9]+$/, ''); // Drop the potential suffix
    })
  );
  const baseRefIndex = branchNames.findIndex((branch) => branch === baseRef);
  return mergeBases[baseRefIndex] || mergeBases[0];
}

export async function checkout(ref: string) {
  return execGitCommand(`git checkout ${ref}`);
}

export async function checkoutPrevious() {
  return execGitCommand(`git checkout -`);
}

export async function discardChanges() {
  return execGitCommand(`git reset --hard`);
}

export async function getRepositoryRoot() {
  return execGitCommand(`git rev-parse --show-toplevel`);
}
