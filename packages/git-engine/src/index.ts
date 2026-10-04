import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitCommit, RecentChange } from '@breadcrumb/shared';

// ─── Git Detection ───────────────────────────────────────────────────────────

export function isGitRepository(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, '.git'));
}

// ─── Execute Git Command ─────────────────────────────────────────────────────

function git(projectPath: string, command: string): string {
  try {
    return execSync(`git ${command}`, {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

// ─── Get Current Branch ──────────────────────────────────────────────────────

export function getCurrentBranch(projectPath: string): string {
  return git(projectPath, 'rev-parse --abbrev-ref HEAD') || 'unknown';
}

// ─── Get Current Commit Hash ─────────────────────────────────────────────────

export function getCurrentCommitHash(projectPath: string): string {
  return git(projectPath, 'rev-parse HEAD') || '';
}

// ─── Get Recent Commits ──────────────────────────────────────────────────────

export function getRecentCommits(projectPath: string, count = 20): GitCommit[] {
  const log = git(projectPath, `log --pretty=format:"%H|%h|%s|%an|%aI" -n ${count}`);
  if (!log) return [];

  return log.split('\n').filter(Boolean).map(line => {
    const [hash, shortHash, message, author, dateStr] = line.split('|');

    // Get changed files for this commit
    const files = git(projectPath, `diff-tree --no-commit-id --name-only -r ${hash}`);
    const changedFiles = files ? files.split('\n').filter(Boolean) : [];

    return {
      hash,
      shortHash,
      message,
      author,
      date: new Date(dateStr),
      changedFiles,
    };
  });
}

// ─── Get Changed Files Since Commit ──────────────────────────────────────────

export function getChangedFilesSince(projectPath: string, commitHash: string): string[] {
  const diff = git(projectPath, `diff --name-only ${commitHash}`);
  if (!diff) return [];
  return diff.split('\n').filter(Boolean);
}

// ─── Get Uncommitted Changes ─────────────────────────────────────────────────

export function getUncommittedChanges(projectPath: string): string[] {
  const status = git(projectPath, 'status --porcelain');
  if (!status) return [];

  return status.split('\n')
    .filter(Boolean)
    .map(line => line.substring(3).trim())
    .filter(Boolean);
}

// ─── Get Staged Files ────────────────────────────────────────────────────────

export function getStagedFiles(projectPath: string): string[] {
  const diff = git(projectPath, 'diff --cached --name-only');
  if (!diff) return [];
  return diff.split('\n').filter(Boolean);
}

// ─── Build Recent Changes ────────────────────────────────────────────────────

export function buildRecentChanges(projectPath: string, count = 10): RecentChange[] {
  const commits = getRecentCommits(projectPath, count);

  return commits.map(commit => ({
    commitHash: commit.hash,
    message: commit.message,
    date: commit.date,
    filesChanged: commit.changedFiles,
    summary: `${commit.shortHash}: ${commit.message} (${commit.changedFiles.length} files)`,
  }));
}

// ─── Detect New Commits Since Last Analysis ──────────────────────────────────

export function getNewCommitsSince(projectPath: string, lastCommitHash: string): GitCommit[] {
  if (!lastCommitHash) return getRecentCommits(projectPath, 5);

  const log = git(projectPath, `log --pretty=format:"%H|%h|%s|%an|%aI" ${lastCommitHash}..HEAD`);
  if (!log) return [];

  return log.split('\n').filter(Boolean).map(line => {
    const [hash, shortHash, message, author, dateStr] = line.split('|');

    const files = git(projectPath, `diff-tree --no-commit-id --name-only -r ${hash}`);
    const changedFiles = files ? files.split('\n').filter(Boolean) : [];

    return {
      hash,
      shortHash,
      message,
      author,
      date: new Date(dateStr),
      changedFiles,
    };
  });
}

// ─── Get File At Commit ──────────────────────────────────────────────────────

export function getFileAtCommit(projectPath: string, filePath: string, commitHash: string): string | null {
  try {
    return git(projectPath, `show ${commitHash}:${filePath}`);
  } catch {
    return null;
  }
}

// ─── Get Blame Info ──────────────────────────────────────────────────────────

export function getRecentAuthors(projectPath: string, filePath: string): string[] {
  const blame = git(projectPath, `log --pretty=format:"%an" --follow -- ${filePath}`);
  if (!blame) return [];
  return [...new Set(blame.split('\n').filter(Boolean))];
}

// ─── Git Summary for Project ─────────────────────────────────────────────────

export interface GitSummary {
  isGitRepo: boolean;
  branch: string;
  currentCommit: string;
  recentCommits: GitCommit[];
  uncommittedChanges: string[];
  totalCommits: number;
  recentChanges: RecentChange[];
}

export function getGitSummary(projectPath: string): GitSummary {
  const isGitRepo = isGitRepository(projectPath);

  if (!isGitRepo) {
    return {
      isGitRepo: false,
      branch: '',
      currentCommit: '',
      recentCommits: [],
      uncommittedChanges: [],
      totalCommits: 0,
      recentChanges: [],
    };
  }

  const countStr = git(projectPath, 'rev-list --count HEAD');
  const totalCommits = parseInt(countStr, 10) || 0;

  return {
    isGitRepo: true,
    branch: getCurrentBranch(projectPath),
    currentCommit: getCurrentCommitHash(projectPath),
    recentCommits: getRecentCommits(projectPath, 10),
    uncommittedChanges: getUncommittedChanges(projectPath),
    totalCommits,
    recentChanges: buildRecentChanges(projectPath, 10),
  };
}
