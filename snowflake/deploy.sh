#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# CrewAI Studio — Build & Push to Snowpark Container Services
# ============================================================
#
# Prerequisites:
#   1. Docker installed and running
#   2. SnowSQL or Snowflake CLI installed (for `snow` commands)
#   3. You have run setup.sql to create the image repo, stage, and compute pool
#   4. You've logged into the Snowflake container registry:
#
#        docker login <org>-<account>.registry.snowflakecomputing.com \
#          -u <snowflake_user>
#
# Usage:
#   ./snowflake/deploy.sh <repo_url>
#
# Example:
#   ./snowflake/deploy.sh org-account.registry.snowflakecomputing.com/crewai_studio/app/crewai_studio_repo
#
# ============================================================

REPO_URL="${1:?Usage: deploy.sh <image_repository_url> [image_tag]}"
# Strip trailing slash so we don't generate `repo//image:tag` on push.
REPO_URL="${REPO_URL%/}"
if [[ -z "${REPO_URL}" ]]; then
  echo "ERROR: repo_url argument is empty" >&2
  exit 2
fi
# A date-stamped tag — overridable via $2 — so each push produces a
# distinct image and spec.yaml stays pinned at a known build instead of
# drifting silently behind a moving :latest.
IMAGE_TAG="${2:-$(date +%Y%m%d-%H%M%S)}"
IMAGE_NAME="crewai-studio"
FULL_IMAGE="${REPO_URL}/${IMAGE_NAME}:${IMAGE_TAG}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPEC_PATH="${SCRIPT_DIR}/spec.yaml"

echo "==> Building Docker image (${IMAGE_NAME}:${IMAGE_TAG})..."
docker build \
  --platform linux/amd64 \
  -t "${IMAGE_NAME}:${IMAGE_TAG}" \
  .

echo "==> Tagging for Snowflake registry..."
docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "${FULL_IMAGE}"

echo "==> Pushing to Snowflake image repository..."
docker push "${FULL_IMAGE}"

# Rewrite the `image:` line in spec.yaml in-place to point at the tag we
# just pushed. Without this, re-running deploy.sh would push a new image
# that the service never sees because spec.yaml still references the
# previous tag.
if [[ -f "${SPEC_PATH}" ]]; then
  echo "==> Updating ${SPEC_PATH} to reference ${FULL_IMAGE}..."
  # mktemp in the same directory as SPEC_PATH so the final `mv` is an
  # atomic rename on the same filesystem. The `&` in the template is
  # mktemp's "use the supplied basename" syntax — keeps the tmp file next
  # to its target.
  SPEC_DIR="$(dirname "${SPEC_PATH}")"
  TMP_SPEC="$(mktemp "${SPEC_DIR}/spec.yaml.XXXXXX")"
  # Clean the tmp file up on any abnormal exit so we never leave a
  # half-written spec.yaml.* lying around.
  trap 'rm -f "${TMP_SPEC}"' EXIT
  awk -v img="${FULL_IMAGE}" '
    match($0, /^[[:space:]]+image:[[:space:]]/) && !done {
      indent = substr($0, 1, RLENGTH - length("image: "))
      print indent "image: " img
      done = 1
      next
    }
    { print }
  ' "${SPEC_PATH}" > "${TMP_SPEC}"
  mv "${TMP_SPEC}" "${SPEC_PATH}"
  # Successful move — disarm the cleanup trap so we don't try to rm the
  # path we just renamed.
  trap - EXIT
else
  echo "WARNING: ${SPEC_PATH} not found — update the image: line manually."
fi

echo ""
echo "==> Image pushed: ${FULL_IMAGE}"
echo ""
echo "Next steps:"
echo "  1. (One-time) Create the PAT secret if not already done:"
echo "       CREATE SECRET SNOWFLAKE_CREWAI_PAT_SECRET TYPE = GENERIC_STRING"
echo "         SECRET_STRING = '<paste PAT>';"
echo "       GRANT USAGE ON SECRET SNOWFLAKE_CREWAI_PAT_SECRET TO ROLE <service-owner-role>;"
echo "  2. Re-upload spec.yaml to the stage so the new image tag takes effect:"
echo "       PUT file://${SPEC_PATH} @CREWAI_DATA/spec/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;"
echo "  3. Create the service (first deploy) or refresh it (subsequent deploys):"
echo "       CREATE SERVICE ... (see setup.sql)"
echo "       -- or --"
echo "       ALTER SERVICE CREWAI_STUDIO_SVC FROM @CREWAI_DATA/spec SPECIFICATION_FILE='spec.yaml';"
echo "  4. Check status:"
echo "       SELECT SYSTEM\$GET_SERVICE_STATUS('CREWAI_STUDIO_SVC');"
echo "       SHOW ENDPOINTS IN SERVICE CREWAI_STUDIO_SVC;"
