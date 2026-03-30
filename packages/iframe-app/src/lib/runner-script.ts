import type { LoomWorker } from './types';

export const WORKFLOW_RUNNER_SCRIPT = `#!/bin/bash
set -eo pipefail

# Hive CI Workflow Runner Script
# Clones a Nostr repository, runs GitHub Actions with act,
# and publishes workflow results back to Nostr.

if [ -z "$HIVE_CI_REPOSITORY" ]; then
  echo "Error: HIVE_CI_REPOSITORY is required"
  exit 1
fi

if [ -z "$HIVE_CI_RUN_ID" ]; then
  echo "Error: HIVE_CI_RUN_ID is required"
  exit 1
fi

if [ -z "$HIVE_CI_NSEC" ]; then
  echo "Error: HIVE_CI_NSEC is required"
  exit 1
fi

BLOSSOM_SERVER="\${HIVE_CI_BLOSSOM_SERVER:-https://blossom.primal.net}"
RELAYS="\${HIVE_CI_RELAYS:-wss://relay.damus.io}"
WORK_DIR="/tmp/hive-ci-\${HIVE_CI_RUN_ID}"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

START_TIME=$(date +%s)
EXIT_CODE=0
ACT_LOG_FILE="\${WORK_DIR}/act-output.log"
touch "$ACT_LOG_FILE"

echo "=== Hive CI Workflow Runner ==="
echo "Repository: \${HIVE_CI_REPOSITORY}"
echo "Workflow: \${HIVE_CI_WORKFLOW:-all workflows}"
echo "Branch: \${HIVE_CI_BRANCH:-default}"
echo "Commit: \${HIVE_CI_COMMIT:-HEAD}"
echo "Run ID: \${HIVE_CI_RUN_ID}"
echo "Working Directory: \${WORK_DIR}"
echo "================================"

NGIT_RELAYS=$(echo "$RELAYS" | tr ',' ';')
git config --global nostr.relay-default-set "$NGIT_RELAYS"

export RUST_BACKTRACE=full
echo ""
echo ">>> Cloning repository..."
CLONE_ARGS=""
if [ -n "$HIVE_CI_BRANCH" ]; then
  CLONE_ARGS="--branch $HIVE_CI_BRANCH"
fi
if ! git clone $CLONE_ARGS "$HIVE_CI_REPOSITORY" 2>&1; then
  echo "Error: Failed to clone repository"
  EXIT_CODE=1
fi

REPO_NAME=$(echo "$HIVE_CI_REPOSITORY" | sed 's|.*/||')
REPO_DIR="\${WORK_DIR}/\${REPO_NAME}"

if [ $EXIT_CODE -eq 0 ]; then
  cd "$REPO_DIR"

  if [ -n "$HIVE_CI_COMMIT" ]; then
    if ! git checkout "$HIVE_CI_COMMIT" 2>&1; then
      echo "Error: Failed to checkout commit \${HIVE_CI_COMMIT}"
      EXIT_CODE=1
    fi
  fi
fi

if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo ">>> Running workflow via act..."
  ACT_ENVS="--env HIVE_CI_NSEC=\${HIVE_CI_NSEC} --env HIVE_CI_RUN_ID=\${HIVE_CI_RUN_ID} --env HIVE_CI_RELAYS=\${RELAYS} --env HIVE_CI_BLOSSOM_SERVER=\${BLOSSOM_SERVER}"

  if [ -n "$HIVE_CI_WORKFLOW" ]; then
    sudo act -P ubuntu-latest=catthehacker/ubuntu:act-latest -W "$HIVE_CI_WORKFLOW" $ACT_ENVS 2>&1 | tee "$ACT_LOG_FILE" || EXIT_CODE=$?
  else
    sudo act -P ubuntu-latest=catthehacker/ubuntu:act-latest $ACT_ENVS 2>&1 | tee "$ACT_LOG_FILE" || EXIT_CODE=$?
  fi
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

if [ $EXIT_CODE -eq 0 ]; then
  STATUS="success"
else
  STATUS="failure"
fi

echo ""
echo "=== Hive CI Workflow Runner Complete ==="
echo "Final Status: \${STATUS}"
echo "Exit Code: \${EXIT_CODE}"
echo "Duration: \${DURATION} seconds"

exit $EXIT_CODE
`;

export function buildRunnerScriptTemplate(
  workflowPath: string,
  worker: LoomWorker | null,
  branch: string
): string {
  const workflowLabel = workflowPath || '[set HIVE_CI_WORKFLOW before submit]';
  const workerLabel = worker
    ? `${worker.name}${worker.architecture ? ` (${worker.architecture})` : ''}${worker.actVersion ? ` act ${worker.actVersion}` : ''}`
    : 'auto-selected worker';

  return [
    `# Suggested for workflow: ${workflowLabel}`,
    `# Suggested branch: ${branch || 'main'}`,
    `# Suggested worker: ${workerLabel}`,
    '# Edit if your workers need extra setup before act runs.',
    '',
    WORKFLOW_RUNNER_SCRIPT,
  ].join('\n');
}

export function buildInlineRunnerArgs(script: string): string[] {
  return [
    '-lc',
    `cat <<'HIVE_CI_RUNNER_SCRIPT_EOF_DELIMITER' >/tmp/run-workflow.sh\n${script}\nHIVE_CI_RUNNER_SCRIPT_EOF_DELIMITER\nchmod +x /tmp/run-workflow.sh\n/tmp/run-workflow.sh`,
  ];
}
