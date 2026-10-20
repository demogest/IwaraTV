#!/usr/bin/env bash
# Writes release-notes.md and release-title.txt for a release.
#   scripts/release-notes.sh <tag> <version> <commit>
# Used by the Build workflow when publishing and by the Release notes workflow
# to refresh an existing release. Hand-written notes in
# docs/release-notes/<tag>.md go first; a "Breaking changes" heading in them
# marks the release title.
set -euo pipefail

TAG_NAME="$1"
VERSION="$2"
TARGET_SHA="$3"
NOTES_FILE="docs/release-notes/${TAG_NAME}.md"

changelog_base=""
changelog_label=""
previous_version=""
previous_sha=""
for commit in $(git rev-list --first-parent "$TARGET_SHA"); do
  commit_version="$(git show "${commit}:package.json" 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version" 2>/dev/null || true)"
  if [[ -n "$commit_version" ]] && [[ "$commit_version" != "$VERSION" ]]; then
    previous_version="$commit_version"
    previous_sha="$commit"
    break
  fi
done

if [[ -n "$previous_version" ]]; then
  previous_tag="v${previous_version}"
  if git rev-parse -q --verify "refs/tags/${previous_tag}^{commit}" >/dev/null && git merge-base --is-ancestor "${previous_tag}^{commit}" "$TARGET_SHA"; then
    changelog_base="$previous_tag"
    changelog_label="$previous_tag"
  else
    changelog_base="$previous_sha"
    changelog_label="${previous_version} baseline (${previous_sha:0:7})"
  fi
else
  previous_tag="$(git tag --merged "$TARGET_SHA" --list "v*" --sort=-v:refname | grep -vx "$TAG_NAME" | head -n 1 || true)"
  if [[ -n "$previous_tag" ]]; then
    changelog_base="$previous_tag"
    changelog_label="$previous_tag"
  fi
fi

{
  if [[ -f "$NOTES_FILE" ]]; then
    cat "$NOTES_FILE"
    echo
  fi
  echo "## Assets"
  echo
  echo "- Windows installer: \`IwaraTV_${VERSION}_x64-setup.exe\`"
  echo "- Windows portable package: \`IwaraTV_${VERSION}_x64-portable.exe\`"
  echo "- Windows unpacked archive: \`IwaraTV_${VERSION}_x64-unpacked.zip\`"
  echo "- macOS disk image (Apple Silicon): \`IwaraTV_${VERSION}_arm64.dmg\`"
  echo "- Linux packages: \`IwaraTV_${VERSION}_amd64.deb\` and \`IwaraTV_${VERSION}_x86_64.AppImage\`"
  echo "- Checksums: \`SHA256SUMS.txt\`"
  echo
  echo "## Changelog"
  echo
  if [[ -n "$changelog_base" ]]; then
    echo "Changes since ${changelog_label}:"
    echo
    git log --no-merges --pretty=format:"- %s (%h)" "${changelog_base}..${TARGET_SHA}"
  else
    echo "Initial release notes:"
    echo
    git log --no-merges --pretty=format:"- %s (%h)" "$TARGET_SHA"
  fi
  echo
} > release-notes.md

if [[ -f "$NOTES_FILE" ]] && grep -qiE '^##+ .*breaking changes' "$NOTES_FILE"; then
  echo "${TAG_NAME} — Breaking changes" > release-title.txt
else
  echo "${TAG_NAME}" > release-title.txt
fi
