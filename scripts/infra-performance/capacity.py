#!/usr/bin/env python3
"""Recompute scenario demand from recorded native costs and explicit planning reserves.

Usage: python3 scripts/infra-performance/capacity.py [scenario.json]
This is a demand model, not an admission promise or a production throughput benchmark.
"""
import json
import math
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT = {
    "history_pages": 1000,
    "capture_statements_96": 2,
    "review_statements_1024": 1,
    "review_statements_4096": 0,
    "absent_searches_20k": 30,
    "product_queue_messages": 200,
    "other_workflow_steps": 200,
    "hosted_turns": 7,
    "inferences_per_turn": 4,
    "input_tokens_per_inference": 20000,
    "output_tokens_per_inference": 250,
    "pending_review_items_at_start": 0,
    "reserve_d1_reads": 20000,
    "reserve_d1_writes": 8000,
    "reserve_queue_operations": 1000,
    "reserve_ai_neurons": 2000,
}
workload = DEFAULT | (json.loads(pathlib.Path(sys.argv[1]).read_text()) if len(sys.argv) > 1 else {})
unknown = set(workload) - set(DEFAULT)
if unknown or any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0 for value in workload.values()):
    raise SystemExit("Scenario requires known nonnegative numeric inputs")
measurements = json.loads((ROOT / "docs/research/infra-capacity-measurements-2026-10-11.json").read_text())
statements = measurements["statementProcessing"]

def statement_cost(kind, rows, field):
    return max(record[field] for record in statements if record["kind"] == kind and record["rows"] == rows)

classes = [("capture_statements_96", "captures", 96), ("review_statements_1024", "review", 1024), ("review_statements_4096", "review", 4096)]
reads = 1440 * 289 + 288 * 4 + workload["history_pages"] * 304 + workload["reserve_d1_reads"]
reads += workload["absent_searches_20k"] * max(record["rowsRead"] for record in measurements["sparseHistory"] if record["count"] == 20000)
writes = 1440 * 21 + workload["reserve_d1_writes"]
steps = 288 + workload["other_workflow_steps"]
for name, kind, rows in classes:
    reads += workload[name] * statement_cost(kind, rows, "rowsRead")
    writes += workload[name] * statement_cost(kind, rows, "rowsWritten")
    steps += workload[name] * statement_cost(kind, rows, "activities")
neurons_per_inference = (9091 * workload["input_tokens_per_inference"] + 27273 * workload["output_tokens_per_inference"]) / 1000000
resources = {
    "d1_reads": (reads, 5000000, 3000000),
    "d1_writes": (writes, 100000, 70000),
    "queue_operations": (4320 + workload["product_queue_messages"] * 3 + workload["reserve_queue_operations"], 10000, 7000),
    "workflow_steps": (steps, 3000, 2100),
    "ai_neurons": (workload["hosted_turns"] * workload["inferences_per_turn"] * neurons_per_inference + workload["reserve_ai_neurons"], 10000, 8000),
}
result = {
    "scenario": workload,
    "resources": {name: {"dailyDemand": amount, "publishedFreeAllocation": limit, "recommendedPlanningBudget": budget, "freeHeadroom": limit - amount, "withinPlanningBudget": amount <= budget} for name, (amount, limit, budget) in resources.items()},
    "highestFreeAllocationFraction": max(resources, key=lambda name: resources[name][0] / resources[name][1]),
    "pendingReviewDemand": workload["pending_review_items_at_start"] + 1024 * workload["review_statements_1024"] + 4096 * workload["review_statements_4096"],
    "installedGlobalPendingReviewLimit": 5000,
    "installedTransactionsPerUserUtcDay": 100,
    "assumptions": [
        "Core and Email idle D1 measured separately; 8000-write/20000-read reserve is an adjustable assumption for canary consumers, release work, admission and unmodeled activity, not an observed idle total.",
        "History cost is the indexed native owner page, excluding transport admission; reserve must cover that admission.",
        "Statement costs include full migrated processing after source staging and entitlement arrangement; staged source creation, upload, coordinator, provider and delivery costs use separate reserves.",
        "Every small product Queue message succeeds once; reserve covers retries and releases. Operational canary consumes 4320 operations/day and creates one Workflow per five-minute period (288 steps/day).",
        "Only measured statement processing activities plus explicit other Workflow steps are modeled; retries do not add billed steps.",
        "AI input/output tokens and calls per Turn are scenario assumptions; live quota refusals override delayed analytics headroom.",
        "Pending review demand assumes no same-day settlement/expiry; demand beyond installed limits is refused rather than fully consumed.",
        "Worker requests/CPU, DO active duration, storage and external-provider cost require separate observed account budgets; this calculator does not infer them from local timings.",
        "Free D1/Queues/AI excess is a refusal risk, not an automatically payable overage. No subscription was changed.",
    ],
}
print(json.dumps(result, indent=2))
