import { describe, expect, it } from "vitest";
import { classifyIssueGraphLiveness as classifyIssueGraphLivenessCompat } from "../services/issue-liveness.ts";
import { decideRunLivenessContinuation as decideRunLivenessContinuationCompat } from "../services/run-continuations.ts";
import {
  RECOVERY_KEY_PREFIXES,
  RECOVERY_ORIGIN_KINDS,
  RECOVERY_REASON_KINDS,
  buildIssueGraphLivenessIncidentKey,
  buildIssueGraphLivenessLeafKey,
  buildRunLivenessContinuationIdempotencyKey,
  classifyIssueGraphLiveness,
  decideRunLivenessContinuation,
  isStrandedIssueRecoveryOriginKind,
  parseIssueGraphLivenessIncidentKey,
} from "../services/recovery/index.ts";

const companyId = "company-1";
const agentId = "agent-1";
const managerId = "manager-1";
const issueId = "issue-1";
const blockerId = "blocker-1";
const runId = "run-1";

function executionStateWithMonitor(input: {
  status?: "scheduled" | "triggered" | "cleared";
  nextCheckAt?: string | null;
}) {
  const status = input.status ?? "scheduled";
  return {
    status: "idle",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: {
      status,
      nextCheckAt: input.nextCheckAt ?? null,
      lastTriggeredAt: null,
      attemptCount: 0,
      notes: null,
      scheduledBy: "assignee",
      kind: null,
      serviceName: null,
      externalRef: null,
      timeoutAt: null,
      maxAttempts: null,
      recoveryPolicy: null,
      clearedAt: status === "cleared" ? "2026-04-30T17:00:00.000Z" : null,
      clearReason: status === "cleared" ? "manual" : null,
    },
  };
}

describe("recovery classifier boundary", () => {
  it("keeps issue graph liveness classifier parity with the compatibility export", () => {
    const input = {
      issues: [
        {
          id: issueId,
          companyId,
          identifier: "PAP-2073",
          title: "Centralize recovery classifiers",
          status: "blocked",
          assigneeAgentId: agentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
        {
          id: blockerId,
          companyId,
          identifier: "PAP-2074",
          title: "Move recovery side effects",
          status: "todo",
          assigneeAgentId: null,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
        },
      ],
      relations: [{ companyId, blockerIssueId: blockerId, blockedIssueId: issueId }],
      agents: [
        {
          id: agentId,
          companyId,
          name: "Coder",
          role: "engineer",
          status: "idle",
          reportsTo: managerId,
        },
        {
          id: managerId,
          companyId,
          name: "CTO",
          role: "cto",
          status: "idle",
          reportsTo: null,
        },
      ],
    };

    expect(classifyIssueGraphLiveness(input)).toEqual(classifyIssueGraphLivenessCompat(input));
  });

  it("treats a scheduled monitor as an explicit review action path", () => {
    const findings = classifyIssueGraphLiveness({
      now: "2026-04-30T18:00:00.000Z",
      issues: [
        {
          id: issueId,
          companyId,
          identifier: "PAP-2945",
          title: "Wait for external review",
          status: "in_review",
          assigneeAgentId: agentId,
          assigneeUserId: null,
          createdByAgentId: null,
          createdByUserId: null,
          executionState: null,
          monitorNextCheckAt: "2026-04-30T19:00:00.000Z",
        },
      ],
      relations: [],
      agents: [
        {
          id: agentId,
          companyId,
          name: "Coder",
          role: "engineer",
          status: "idle",
          reportsTo: managerId,
        },
        {
          id: managerId,
          companyId,
          name: "CTO",
          role: "cto",
          status: "idle",
          reportsTo: null,
        },
      ],
    });

    expect(findings).toEqual([]);
  });

  it("does not treat overdue or exhausted monitors as explicit waiting paths", () => {
    const baseIssue = {
      id: issueId,
      companyId,
      identifier: "PAP-2945",
      title: "Wait for external review",
      status: "in_review",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
    };
    const agents = [
      {
        id: agentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
      },
    ];

    const overdue = classifyIssueGraphLiveness({
      now: "2026-04-30T20:00:00.000Z",
      issues: [
        {
          ...baseIssue,
          executionState: null,
          monitorNextCheckAt: "2026-04-30T19:00:00.000Z",
        },
      ],
      relations: [],
      agents,
    });

    const exhausted = classifyIssueGraphLiveness({
      now: "2026-04-30T18:00:00.000Z",
      issues: [
        {
          ...baseIssue,
          executionPolicy: {
            monitor: {
              nextCheckAt: "2026-04-30T19:00:00.000Z",
              maxAttempts: 1,
            },
          },
          executionState: null,
          monitorNextCheckAt: "2026-04-30T19:00:00.000Z",
          monitorAttemptCount: 1,
        },
      ],
      relations: [],
      agents,
    });

    expect(overdue[0]?.state).toBe("in_review_without_action_path");
    expect(exhausted[0]?.state).toBe("in_review_without_action_path");
  });

  it("fails closed when persisted monitor metadata is malformed or no longer scheduled", () => {
    const nextCheckAt = "2026-04-30T19:00:00.000Z";
    const baseIssue = {
      id: issueId,
      companyId,
      identifier: "PAP-2945",
      title: "Wait for external review",
      status: "in_review",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount: 0,
    };
    const agents = [
      {
        id: agentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
      },
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        reportsTo: null,
      },
    ];
    const cases = [
      {
        name: "malformed policy next-check",
        patch: { executionPolicy: { monitor: { nextCheckAt: "not-a-date" } } },
      },
      {
        name: "mismatched state next-check",
        patch: { executionState: executionStateWithMonitor({ nextCheckAt: "2026-04-30T19:30:00.000Z" }) },
      },
      {
        name: "cleared monitor state",
        patch: { executionState: executionStateWithMonitor({ status: "cleared", nextCheckAt }) },
      },
      {
        name: "max-attempts above schema bound",
        patch: { executionPolicy: { monitor: { nextCheckAt, maxAttempts: 101 } } },
      },
      {
        name: "malformed timeout",
        patch: { executionPolicy: { monitor: { nextCheckAt, timeoutAt: "not-a-date" } } },
      },
    ];

    for (const testCase of cases) {
      const findings = classifyIssueGraphLiveness({
        now: "2026-04-30T18:00:00.000Z",
        issues: [{ ...baseIssue, ...testCase.patch }],
        relations: [],
        agents,
      });

      expect(findings.length, testCase.name).toBeGreaterThan(0);
    }
  });

  it("requires an eligible blocker status and an invokable same-company monitor assignee", () => {
    const now = "2026-04-30T18:00:00.000Z";
    const nextCheckAt = "2026-04-30T19:00:00.000Z";
    const rootIssue = {
      id: issueId,
      companyId,
      identifier: "PAP-2945",
      title: "Blocked root",
      status: "blocked",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
    };
    const baseBlocker = {
      id: blockerId,
      companyId,
      identifier: "PAP-2946",
      title: "Monitor-backed blocker",
      status: "in_progress",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      monitorNextCheckAt: nextCheckAt,
    };
    const relation = { companyId, blockerIssueId: blockerId, blockedIssueId: issueId };
    const cases = [
      {
        name: "ineligible issue status",
        blocker: { ...baseBlocker, status: "backlog" },
        agents: [{ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle", reportsTo: null }],
      },
      {
        name: "paused assignee",
        blocker: baseBlocker,
        agents: [{ id: agentId, companyId, name: "Coder", role: "engineer", status: "paused", reportsTo: null }],
      },
      {
        name: "cross-company assignee",
        blocker: baseBlocker,
        agents: [{ id: agentId, companyId: "company-2", name: "Coder", role: "engineer", status: "idle", reportsTo: null }],
      },
    ];

    for (const testCase of cases) {
      const findings = classifyIssueGraphLiveness({
        now,
        issues: [rootIssue, testCase.blocker],
        relations: [relation],
        agents: testCase.agents,
      });

      expect(findings, testCase.name).toHaveLength(1);
    }
  });

  it("keeps run liveness continuation decision parity with the compatibility export", () => {
    const input = {
      run: {
        id: runId,
        companyId,
        agentId,
        continuationAttempt: 0,
      } as never,
      issue: {
        id: issueId,
        companyId,
        identifier: "PAP-2073",
        title: "Centralize recovery classifiers",
        status: "in_progress",
        assigneeAgentId: agentId,
        executionState: null,
        projectId: null,
      } as never,
      agent: {
        id: agentId,
        companyId,
        status: "idle",
      } as never,
      livenessState: "plan_only" as const,
      livenessReason: "Planned without acting",
      nextAction: "Take the first concrete action.",
      budgetBlocked: false,
      idempotentWakeExists: false,
    };

    expect(decideRunLivenessContinuation(input)).toEqual(decideRunLivenessContinuationCompat(input));
  });

  it("keeps recovery origin and idempotency keys stable", () => {
    expect(RECOVERY_ORIGIN_KINDS).toMatchObject({
      issueGraphLivenessEscalation: "harness_liveness_escalation",
      strandedIssueRecovery: "stranded_issue_recovery",
      staleActiveRunEvaluation: "stale_active_run_evaluation",
    });
    expect(RECOVERY_REASON_KINDS.runLivenessContinuation).toBe("run_liveness_continuation");
    expect(RECOVERY_KEY_PREFIXES.issueGraphLivenessIncident).toBe("harness_liveness");
    expect(RECOVERY_KEY_PREFIXES.issueGraphLivenessLeaf).toBe("harness_liveness_leaf");

    const incidentKey = buildIssueGraphLivenessIncidentKey({
      companyId,
      issueId,
      state: "blocked_by_unassigned_issue",
      blockerIssueId: blockerId,
    });
    expect(incidentKey).toBe(
      "harness_liveness:company-1:issue-1:blocked_by_unassigned_issue:blocker-1",
    );
    expect(parseIssueGraphLivenessIncidentKey(incidentKey)).toEqual({
      companyId,
      issueId,
      state: "blocked_by_unassigned_issue",
      leafIssueId: blockerId,
    });
    expect(buildIssueGraphLivenessLeafKey({
      companyId,
      state: "blocked_by_unassigned_issue",
      leafIssueId: blockerId,
    })).toBe("harness_liveness_leaf:company-1:blocked_by_unassigned_issue:blocker-1");
    expect(buildRunLivenessContinuationIdempotencyKey({
      issueId,
      sourceRunId: runId,
      livenessState: "plan_only",
      nextAttempt: 1,
    })).toBe("run_liveness_continuation:issue-1:run-1:plan_only:1");
  });

  it("classifies stranded recovery origins as recovery-owned work", () => {
    expect(isStrandedIssueRecoveryOriginKind("stranded_issue_recovery")).toBe(true);
    expect(isStrandedIssueRecoveryOriginKind("harness_liveness_escalation")).toBe(false);
    expect(isStrandedIssueRecoveryOriginKind("manual")).toBe(false);
    expect(isStrandedIssueRecoveryOriginKind(null)).toBe(false);
  });
});
