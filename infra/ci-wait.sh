#!/usr/bin/env bash
# Выкладка идёт только после зелёного CI того же коммита.
# Ждёт прогон workflow «CI» для $GITHUB_SHA (до 20 минут): success — выходим 0, иначе — 1.
# Сборка в выкладке идёт параллельно с CI, ждём только перед шагами, которые меняют серверы.
#   infra/ci-wait.sh            (нужны GH_TOKEN с actions:read, GITHUB_REPOSITORY, GITHUB_SHA)
set -euo pipefail
sha="${GITHUB_SHA:?}"
repo="${GITHUB_REPOSITORY:?}"
deadline=$(( $(date +%s) + 20 * 60 ))
seen=0
while :; do
  # последний прогон CI на этот коммит (перезапуск вручную тоже считается)
  line=$(gh api "repos/$repo/actions/workflows/ci.yml/runs?head_sha=$sha&per_page=5" \
    --jq '.workflow_runs | sort_by(.run_number) | last | select(.) | "\(.status) \(.conclusion) \(.html_url)"' 2>/dev/null || true)
  if [ -n "$line" ]; then
    seen=1
    read -r status conclusion url <<<"$line"
    if [ "$status" = completed ]; then
      if [ "$conclusion" = success ]; then
        echo "CI зелёный: $url"
        exit 0
      fi
      echo "::error::CI для ${sha:0:7} — $conclusion, выкладка отменена: $url"
      exit 1
    fi
    echo "CI ещё идёт ($status)…"
  else
    echo "прогона CI для ${sha:0:7} пока нет…"
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    [ "$seen" = 1 ] && echo "::error::CI не закончился за 20 минут" || echo "::error::CI для ${sha:0:7} так и не запустился"
    exit 1
  fi
  sleep 15
done
