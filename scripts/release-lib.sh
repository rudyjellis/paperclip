#!/usr/bin/env bash

if [ -z "${REPO_ROOT:-}" ]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

release_info() {
  echo "$@"
}

release_warn() {
  echo "Warning: $*" >&2
}

release_fail() {
  echo "Error: $*" >&2
  exit 1
}

git_remote_exists() {
  git -C "$REPO_ROOT" remote get-url "$1" >/dev/null 2>&1
}

git_remote_url() {
  git -C "$REPO_ROOT" remote get-url "$1" 2>/dev/null || true
}

github_repo_from_remote() {
  local remote_url

  remote_url="$(git_remote_url "$1")"
  [ -n "$remote_url" ] || return 1

  remote_url="${remote_url%.git}"

  node - "$remote_url" <<'NODE'
const remoteUrl = process.argv[2];

const patterns = [
  /^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i,
  /^ssh:\/\/git@github\.com(?::\d+)?\/([^/]+\/[^/]+)$/i,
  /^git@github\.com:([^/]+\/[^/]+)$/i,
  /^git@github\.com\/([^/]+\/[^/]+)$/i,
  /^[^:]+:([^/]+\/[^/]+)$/
];

for (const pattern of patterns) {
  const match = remoteUrl.match(pattern);
  if (!match) continue;
  process.stdout.write(match[1]);
  process.exit(0);
}

process.exit(1);
NODE
}

github_remote_url_points_to_github_com() {
  local remote_url

  remote_url="$(git_remote_url "$1")"
  remote_url="$(printf '%s' "$remote_url" | tr '[:upper:]' '[:lower:]')"

  case "$remote_url" in
    http://github.com/*|https://github.com/*|ssh://git@github.com/*|ssh://git@github.com:*|git@github.com:*|git@github.com/*)
      return 0
      ;;
  esac

  return 1
}

normalize_github_repo_name() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's#^/+##; s#/+$##; s#\.git$##'
}

paperclip_upstream_repo_name() {
  normalize_github_repo_name "${PAPERCLIP_UPSTREAM_REPO:-paperclipai/paperclip}"
}

has_explicit_paperclip_upstream_intent() {
  case "${PAPERCLIP_UPSTREAM_INTENT:-}" in
    1|true|TRUE|yes|YES|release|github-actions-release|upstream)
      return 0
      ;;
  esac

  case "${PAPERCLIP_ALLOW_UPSTREAM_PUBLISH:-}" in
    1|true|TRUE|yes|YES)
      return 0
      ;;
  esac

  return 1
}

assert_paperclip_publish_remote_allowed() {
  local remote="$1"
  local repo
  local upstream_repo

  repo="$(github_repo_from_remote "$remote" || true)"
  if [ -z "$repo" ]; then
    if github_remote_url_points_to_github_com "$remote"; then
      release_fail "Paperclip internal GitHub publish automation could not determine the GitHub repository for git remote '$remote'. Refusing to continue so it cannot silently target upstream; use a standard fork remote URL or submit an internal Paperclip issue for upstream coordination before setting PAPERCLIP_UPSTREAM_INTENT."
    fi
    return 0
  fi

  upstream_repo="$(paperclip_upstream_repo_name)"
  if [ "$(normalize_github_repo_name "$repo")" != "$upstream_repo" ]; then
    return 0
  fi

  if has_explicit_paperclip_upstream_intent; then
    release_warn "upstream Paperclip publish target allowed by PAPERCLIP_UPSTREAM_INTENT/PAPERCLIP_ALLOW_UPSTREAM_PUBLISH."
    return 0
  fi

  release_fail "Paperclip internal GitHub publish automation refuses to target upstream repo $upstream_repo via git remote '$remote'. Use the configured fork remote (for example PUBLISH_REMOTE=fork) for internal work, or submit an internal Paperclip issue for upstream coordination before setting PAPERCLIP_UPSTREAM_INTENT."
}

resolve_release_remote() {
  local remote="${RELEASE_REMOTE:-${PUBLISH_REMOTE:-}}"

  if [ -n "$remote" ]; then
    git_remote_exists "$remote" || release_fail "git remote '$remote' does not exist."
    assert_paperclip_publish_remote_allowed "$remote"
    printf '%s\n' "$remote"
    return
  fi

  if git_remote_exists fork; then
    assert_paperclip_publish_remote_allowed fork
    printf 'fork\n'
    return
  fi

  if git_remote_exists public-gh; then
    assert_paperclip_publish_remote_allowed public-gh
    printf 'public-gh\n'
    return
  fi

  if git_remote_exists public; then
    assert_paperclip_publish_remote_allowed public
    printf 'public\n'
    return
  fi

  if git_remote_exists origin; then
    assert_paperclip_publish_remote_allowed origin
    printf 'origin\n'
    return
  fi

  release_fail "no git remote found. Configure RELEASE_REMOTE or PUBLISH_REMOTE."
}

fetch_release_remote() {
  git -C "$REPO_ROOT" fetch "$1" --prune --tags
}

git_current_branch() {
  git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true
}

git_local_tag_exists() {
  git -C "$REPO_ROOT" show-ref --verify --quiet "refs/tags/$1"
}

git_remote_tag_exists() {
  git -C "$REPO_ROOT" ls-remote --exit-code --tags "$2" "refs/tags/$1" >/dev/null 2>&1
}

get_last_stable_tag() {
  git -C "$REPO_ROOT" tag --list 'v*' --sort=-version:refname | head -1
}

get_current_stable_version() {
  local tag
  tag="$(get_last_stable_tag)"
  if [ -z "$tag" ]; then
    printf '0.0.0\n'
  else
    printf '%s\n' "${tag#v}"
  fi
}

stable_version_slot_for_date() {
  node - "${1:-}" <<'NODE'
const input = process.argv[2];

const date = input ? new Date(`${input}T00:00:00Z`) : new Date();
if (Number.isNaN(date.getTime())) {
  console.error(`invalid date: ${input}`);
  process.exit(1);
}

const month = String(date.getUTCMonth() + 1);
const day = String(date.getUTCDate()).padStart(2, '0');

process.stdout.write(`${date.getUTCFullYear()}.${month}${day}`);
NODE
}

utc_date_iso() {
  node <<'NODE'
const date = new Date();
const y = date.getUTCFullYear();
const m = String(date.getUTCMonth() + 1).padStart(2, '0');
const d = String(date.getUTCDate()).padStart(2, '0');
process.stdout.write(`${y}-${m}-${d}`);
NODE
}

next_stable_version() {
  local release_date="$1"
  shift

  node - "$release_date" "$@" <<'NODE'
const input = process.argv[2];
const packageNames = process.argv.slice(3);
const { execSync } = require("node:child_process");

const date = input ? new Date(`${input}T00:00:00Z`) : new Date();
if (Number.isNaN(date.getTime())) {
  console.error(`invalid date: ${input}`);
  process.exit(1);
}

const stableSlot = `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}${String(date.getUTCDate()).padStart(2, "0")}`;
const pattern = new RegExp(`^${stableSlot.replace(/\./g, '\\.')}\.(\\d+)$`);
let max = -1;

for (const packageName of packageNames) {
  let versions = [];

  try {
    const raw = execSync(`npm view ${JSON.stringify(packageName)} versions --json`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (raw) {
      const parsed = JSON.parse(raw);
      versions = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch {
    versions = [];
  }

  for (const version of versions) {
    const match = version.match(pattern);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
}

process.stdout.write(`${stableSlot}.${max + 1}`);
NODE
}

next_canary_version() {
  local stable_version="$1"
  shift

  node - "$stable_version" "$@" <<'NODE'
const stable = process.argv[2];
const packageNames = process.argv.slice(3);
const { execSync } = require("node:child_process");

const pattern = new RegExp(`^${stable.replace(/\./g, '\\.')}-canary\\.(\\d+)$`);
let max = -1;

for (const packageName of packageNames) {
  let versions = [];

  try {
    const raw = execSync(`npm view ${JSON.stringify(packageName)} versions --json`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (raw) {
      const parsed = JSON.parse(raw);
      versions = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch {
    versions = [];
  }
 
  for (const version of versions) {
    const match = version.match(pattern);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
}

process.stdout.write(`${stable}-canary.${max + 1}`);
NODE
}

release_notes_file() {
  printf '%s/releases/v%s.md\n' "$REPO_ROOT" "$1"
}

stable_tag_name() {
  printf 'v%s\n' "$1"
}

canary_tag_name() {
  printf 'canary/v%s\n' "$1"
}

npm_package_version_exists() {
  local package_name="$1"
  local version="$2"
  local resolved

  resolved="$(npm view "${package_name}@${version}" version 2>/dev/null || true)"
  [ "$resolved" = "$version" ]
}

wait_for_npm_package_version() {
  local package_name="$1"
  local version="$2"
  local attempts="${3:-12}"
  local delay_seconds="${4:-5}"
  local attempt=1

  while [ "$attempt" -le "$attempts" ]; do
    if npm_package_version_exists "$package_name" "$version"; then
      return 0
    fi

    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$delay_seconds"
    fi
    attempt=$((attempt + 1))
  done

  return 1
}

require_clean_worktree() {
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
    release_fail "working tree is not clean. Commit, stash, or remove changes before releasing."
  fi
}

require_on_master_branch() {
  local current_branch
  current_branch="$(git_current_branch)"
  if [ "$current_branch" != "master" ]; then
    release_fail "this release step must run from branch master, but current branch is ${current_branch:-<detached>}."
  fi
}

require_npm_publish_auth() {
  local dry_run="$1"

  if [ "$dry_run" = true ]; then
    return
  fi

  if npm whoami >/dev/null 2>&1; then
    release_info "  ✓ Logged in to npm as $(npm whoami)"
    return
  fi

  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    release_info "  ✓ npm publish auth will be provided by GitHub Actions trusted publishing"
    return
  fi

  release_fail "npm publish auth is not available. Use 'npm login' locally or run from GitHub Actions with trusted publishing."
}

list_public_package_info() {
  node "$REPO_ROOT/scripts/release-package-map.mjs" list
}

set_public_package_version() {
  node "$REPO_ROOT/scripts/release-package-map.mjs" set-version "$1"
}
