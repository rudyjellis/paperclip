// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval, ApprovalComment, Issue } from "@paperclipai/shared";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalDetail } from "./ApprovalDetail";

const mockApprovalsApi = vi.hoisted(() => ({
  get: vi.fn(),
  listComments: vi.fn(),
  listIssues: vi.fn(),
  getReviewedArtifacts: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  addComment: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockReviewedAssetsPanelRender = vi.hoisted(() => vi.fn());

vi.mock("../api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    children?: ReactNode;
    to: string;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
  useParams: () => ({ approvalId: "approval-1" }),
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("../components/Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("../components/ApprovalPayload", () => ({
  approvalLabel: () => "Approval",
  typeIcon: {},
  defaultTypeIcon: () => <span>icon</span>,
  ApprovalPayloadRenderer: () => <div data-testid="approval-payload">Payload</div>,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>Loading</div>,
}));

vi.mock("../components/ReviewedAssetsPanel", () => ({
  ReviewedAssetsPanel: (props: unknown) => {
    mockReviewedAssetsPanelRender(props);
    return <div data-testid="reviewed-assets-panel">Reviewed assets</div>;
  },
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    type = "button",
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushReact();
    }
  }
  throw lastError;
}

function createApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-07-22T00:00:00.000Z"),
    updatedAt: new Date("2026-07-22T00:00:00.000Z"),
    ...overrides,
  };
}

function createLinkedIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Reviewed issue",
    description: null,
    status: "in_review",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    currentExecutionWorkspace: null,
    createdByAgentId: null,
    createdByUserId: null,
    identifier: "PAP-1",
    issueNumber: 1,
    originKind: "manual",
    originId: null,
    originRunId: null,
    originFingerprint: "default",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-07-22T00:00:00.000Z"),
    updatedAt: new Date("2026-07-22T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    ancestors: [],
    documentSummaries: [],
    ...overrides,
  } as Issue;
}

function createComment(overrides: Partial<ApprovalComment> = {}): ApprovalComment {
  return {
    id: "comment-1",
    companyId: "company-1",
    approvalId: "approval-1",
    authorAgentId: "agent-1",
    authorUserId: null,
    body: "Looks good",
    createdAt: new Date("2026-07-22T00:00:00.000Z"),
    updatedAt: new Date("2026-07-22T00:00:00.000Z"),
    ...overrides,
  };
}

describe("ApprovalDetail", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    mockApprovalsApi.get.mockResolvedValue(createApproval());
    mockApprovalsApi.listComments.mockResolvedValue([createComment()]);
    mockApprovalsApi.listIssues.mockResolvedValue([createLinkedIssue()]);
    mockApprovalsApi.getReviewedArtifacts.mockResolvedValue({
      contextType: "approval_review",
      artifacts: [],
      errors: [],
    });
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "Reviewer" }]);
    mockReviewedAssetsPanelRender.mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it("loads reviewed assets for actionable approvals and renders the panel", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    await waitForAssertion(() => {
      expect(mockApprovalsApi.getReviewedArtifacts).toHaveBeenCalledWith("approval-1");
      expect(container.querySelector('[data-testid="reviewed-assets-panel"]')).not.toBeNull();
      expect(mockReviewedAssetsPanelRender).toHaveBeenCalledWith(
        expect.objectContaining({
          issuePathId: "PAP-1",
          companyId: "company-1",
          isLoading: false,
        }),
      );
    });
  });
});
