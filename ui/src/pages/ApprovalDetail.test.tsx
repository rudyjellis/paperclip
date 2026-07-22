// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
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
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockReviewedAssetsPanelRender = vi.hoisted(() => vi.fn());

vi.mock("../api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children?: ReactNode; to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
  useParams: () => ({ approvalId: "approval-1" }),
  useSearchParams: () => [new URLSearchParams("")],
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    setSelectedCompanyId: mockSetSelectedCompanyId,
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
  approvalLabel: () => "Approval request",
  typeIcon: {},
  defaultTypeIcon: () => <span>icon</span>,
  ApprovalPayloadRenderer: () => <div>Payload</div>,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>Loading</div>,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/ReviewedAssetsPanel", () => ({
  ReviewedAssetsPanel: (props: { error?: unknown; isLoading?: boolean; issuePathId?: string | null }) => {
    mockReviewedAssetsPanelRender(props);
    return (
      <div
        data-testid="reviewed-assets-panel"
        data-state={props.isLoading ? "loading" : props.error ? "error" : "ready"}
        data-issue-path-id={props.issuePathId ?? ""}
      >
        Reviewed assets
      </div>
    );
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    type = "button",
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

    mockApprovalsApi.get.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      status: "pending",
      type: "request_board_approval",
      payload: { title: "Approval request" },
      requestedByAgentId: "agent-1",
      decisionNote: null,
    });
    mockApprovalsApi.listComments.mockResolvedValue([]);
    mockApprovalsApi.listIssues.mockResolvedValue([
      { id: "issue-1", identifier: "PAP-1", title: "Review assets task" },
    ]);
    mockApprovalsApi.getReviewedArtifacts.mockRejectedValue(new Error("Reviewed assets failed"));
    mockApprovalsApi.approve.mockResolvedValue({});
    mockApprovalsApi.reject.mockResolvedValue({});
    mockApprovalsApi.requestRevision.mockResolvedValue({});
    mockApprovalsApi.resubmit.mockResolvedValue({});
    mockApprovalsApi.addComment.mockResolvedValue({});
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "CodexCoder" }]);
    mockReviewedAssetsPanelRender.mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("places reviewed assets before decision controls and keeps approve actions usable on asset failure", async () => {
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
      const panel = container.querySelector('[data-testid="reviewed-assets-panel"]');
      const approveButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Approve"),
      );
      expect(panel).toBeTruthy();
      expect(panel?.getAttribute("data-state")).toBe("error");
      expect(panel?.getAttribute("data-issue-path-id")).toBe("PAP-1");
      expect(approveButton).toBeTruthy();
      expect(Boolean(panel?.compareDocumentPosition(approveButton!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      expect(container.textContent).toContain("Reject");
      expect(container.textContent).toContain("Request revision");
    });

    const approveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Approve"),
    );
    await act(async () => {
      approveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockApprovalsApi.approve).toHaveBeenCalledWith("approval-1");
  });
});
