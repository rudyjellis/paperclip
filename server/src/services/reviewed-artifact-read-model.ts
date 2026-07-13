import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  assets,
  documentRevisions,
  documents,
  executionWorkspaces,
  issueAttachments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import type {
  IssueWorkProduct,
  ReviewedArtifactError,
  ReviewedArtifactIssueSummary,
  ReviewedArtifactItem,
  ReviewedArtifactPreview,
  ReviewedArtifactResolved,
  ReviewedArtifactResolution,
  ReviewedArtifactSet,
  ReviewedArtifactsResponse,
} from "@paperclipai/shared";
import { normalizeContentType, SVG_CONTENT_TYPE } from "../attachment-types.js";
import { issueApprovalService } from "./issue-approvals.js";
import { reviewedArtifactService } from "./reviewed-artifacts.js";
import { workProductService } from "./work-products.js";

const MAX_INLINE_PREVIEW_CHARS = 100_000;

type ReviewedArtifactActorType = "board" | "agent";

type IssueSummaryRow = {
  id: string;
  identifier: string | null;
  title: string;
  executionWorkspaceId: string | null;
};

type ResolvedDocumentRow = {
  issueId: string;
  key: string;
  title: string | null;
  format: string;
  body: string;
  revisionId: string | null;
  revisionNumber: number | null;
};

function toIssueSummary(row: IssueSummaryRow | null): ReviewedArtifactIssueSummary | null {
  if (!row) return null;
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
  };
}

function missingResolution(reason: string): ReviewedArtifactResolution {
  return { status: "missing", reason };
}

function unavailableResolution(reason: string): ReviewedArtifactResolution {
  return { status: "unavailable", reason };
}

function permissionDeniedResolution(reason: string): ReviewedArtifactResolution {
  return { status: "permission_denied", reason };
}

function tooLargeResolution(reason: string): ReviewedArtifactResolution {
  return { status: "too_large", reason };
}

function resolvedResolution(reason: string | null = null): ReviewedArtifactResolution {
  return { status: "resolved", reason };
}

function unsupportedPreview(reason: string | null = null): ReviewedArtifactPreview {
  return {
    mode: "unsupported",
    previewable: false,
    previewUrl: null,
    downloadUrl: null,
    externalUrl: null,
    contentType: null,
    byteSize: null,
    markdownBody: null,
    ...(reason ? {} : {}),
  };
}

function markdownPreview(markdownBody: string): ReviewedArtifactPreview {
  return {
    mode: "markdown",
    previewable: true,
    previewUrl: null,
    downloadUrl: null,
    externalUrl: null,
    contentType: "text/markdown",
    byteSize: Buffer.byteLength(markdownBody, "utf8"),
    markdownBody,
  };
}

function imagePreview(url: string, contentType: string | null, byteSize: number | null): ReviewedArtifactPreview {
  return {
    mode: "image",
    previewable: true,
    previewUrl: url,
    downloadUrl: `${url}?download=1`,
    externalUrl: null,
    contentType,
    byteSize,
    markdownBody: null,
  };
}

function linkPreview(url: string): ReviewedArtifactPreview {
  return {
    mode: "link",
    previewable: true,
    previewUrl: url,
    downloadUrl: null,
    externalUrl: url,
    contentType: null,
    byteSize: null,
    markdownBody: null,
  };
}

function downloadPreview(
  url: string | null,
  contentType: string | null,
  byteSize: number | null,
): ReviewedArtifactPreview {
  return {
    mode: "download_only",
    previewable: false,
    previewUrl: null,
    downloadUrl: url,
    externalUrl: null,
    contentType,
    byteSize,
    markdownBody: null,
  };
}

function isInlinePreviewTooLarge(body: string) {
  return body.length > MAX_INLINE_PREVIEW_CHARS;
}

function fileExtension(path: string) {
  const filename = path.split("/").pop() ?? path;
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex < 0) return "";
  return filename.slice(dotIndex + 1).toLowerCase();
}

function isImageContentType(contentType: string) {
  return contentType.startsWith("image/") && contentType !== SVG_CONTENT_TYPE;
}

function isLikelyMarkdownFormat(format: string | null | undefined) {
  return typeof format === "string" && format.trim().toLowerCase() === "markdown";
}

function safeUrlHostname(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function jsonCodeFence(value: unknown) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function textPreviewFromValue(value: unknown): { preview: ReviewedArtifactPreview; resolution: ReviewedArtifactResolution } {
  const body =
    typeof value === "string"
      ? value
      : jsonCodeFence(value);
  if (isInlinePreviewTooLarge(body)) {
    return {
      preview: unsupportedPreview(),
      resolution: tooLargeResolution("Inline preview exceeded the reviewed-artifact size limit."),
    };
  }
  return {
    preview: markdownPreview(body),
    resolution: resolvedResolution(),
  };
}

function defaultArtifactTitle(item: ReviewedArtifactItem, fallback: string) {
  const title = item.title?.trim();
  return title && title.length > 0 ? title : fallback;
}

function withBaseResolvedArtifact(
  item: ReviewedArtifactItem,
  overrides: Partial<ReviewedArtifactResolved>,
): ReviewedArtifactResolved {
  return {
    id: item.id,
    sourceType: item.sourceType,
    source: item.source as Record<string, unknown>,
    sourceIssue: null,
    title: defaultArtifactTitle(item, "Reviewed artifact"),
    description: item.description ?? null,
    sortOrder: item.orderIndex,
    isPrimary: item.isPrimary,
    required: item.required,
    selectedExplicitly: item.selectedExplicitly,
    resolution: resolvedResolution(),
    preview: unsupportedPreview(),
    document: null,
    snapshot: item.metadata ?? null,
    ...overrides,
  };
}

function resolveJsonPointerValue(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value: root };
  if (!pointer.startsWith("/")) return { found: false };

  let current: unknown = root;
  for (const rawToken of pointer.split("/").slice(1)) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") return { found: false };
    if (!(token in current)) return { found: false };
    current = (current as Record<string, unknown>)[token];
  }

  return { found: true, value: current };
}

function workProductPreviewMode(workProduct: IssueWorkProduct) {
  const metadata = workProduct.metadata ?? {};
  const metadataMode = typeof metadata.previewMode === "string" ? metadata.previewMode : null;
  if (metadataMode === "markdown" ||
      metadataMode === "image" ||
      metadataMode === "link" ||
      metadataMode === "download_only" ||
      metadataMode === "json" ||
      metadataMode === "unsupported") {
    return metadataMode;
  }
  if (workProduct.url) return "link";
  if (typeof metadata.downloadUrl === "string" && metadata.downloadUrl.trim()) return "download_only";
  return "unsupported";
}

function buildSuggestedArtifactFromWorkProduct(
  issue: IssueSummaryRow,
  workProduct: IssueWorkProduct,
  index: number,
): ReviewedArtifactResolved {
  const metadata = workProduct.metadata ?? {};
  const previewMode = workProductPreviewMode(workProduct);
  const previewUrl = typeof metadata.previewUrl === "string" ? metadata.previewUrl : null;
  const downloadUrl = typeof metadata.downloadUrl === "string" ? metadata.downloadUrl : null;
  const contentType = typeof metadata.contentType === "string" ? metadata.contentType : null;
  const byteSize = typeof metadata.byteSize === "number" ? metadata.byteSize : null;
  const documentKey = typeof metadata.documentKey === "string" ? metadata.documentKey : null;
  const documentRevisionId = typeof metadata.documentRevisionId === "string" ? metadata.documentRevisionId : null;

  return {
    id: `suggested-work-product:${workProduct.id}`,
    sourceType: "issue_work_product",
    source: { type: "issue_work_product", issueId: issue.id, workProductId: workProduct.id },
    sourceIssue: toIssueSummary(issue),
    title: workProduct.title,
    description: workProduct.summary,
    sortOrder: index,
    isPrimary: workProduct.isPrimary,
    required: false,
    selectedExplicitly: false,
    resolution: {
      status: workProduct.status === "archived" || workProduct.status === "closed" ? "unavailable" : "resolved",
      reason: null,
    },
    preview: {
      mode: previewMode,
      previewable: previewMode === "link" || Boolean(previewUrl),
      previewUrl,
      downloadUrl,
      externalUrl: workProduct.url,
      contentType,
      byteSize,
      markdownBody: null,
    },
    document: documentKey
      ? { key: documentKey, revisionId: documentRevisionId, revisionNumber: null }
      : null,
    snapshot: {
      provider: workProduct.provider,
      status: workProduct.status,
      healthStatus: workProduct.healthStatus,
      reviewState: workProduct.reviewState,
      createdAt: workProduct.createdAt,
      updatedAt: workProduct.updatedAt,
    },
  };
}

export function reviewedArtifactReadModelService(db: Db) {
  const reviewedArtifacts = reviewedArtifactService(db);
  const issueApprovals = issueApprovalService(db);
  const workProducts = workProductService(db);

  const issueSummaryCache = new Map<string, Promise<IssueSummaryRow | null>>();

  async function getIssueSummary(companyId: string, issueId: string) {
    const cacheKey = `${companyId}:${issueId}`;
    let pending = issueSummaryCache.get(cacheKey);
    if (!pending) {
      pending = db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          executionWorkspaceId: issues.executionWorkspaceId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
        .then((rows) => rows[0] ?? null);
      issueSummaryCache.set(cacheKey, pending);
    }
    return pending;
  }

  async function getDocumentVersion(
    companyId: string,
    issueId: string,
    key: string,
    revisionId: string | null,
  ): Promise<ResolvedDocumentRow | null> {
    if (revisionId) {
      return db
        .select({
          issueId: issueDocuments.issueId,
          key: issueDocuments.key,
          title: documentRevisions.title,
          format: documentRevisions.format,
          body: documentRevisions.body,
          revisionId: documentRevisions.id,
          revisionNumber: documentRevisions.revisionNumber,
        })
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .innerJoin(documentRevisions, eq(documentRevisions.documentId, documents.id))
        .where(and(
          eq(issueDocuments.companyId, companyId),
          eq(issueDocuments.issueId, issueId),
          eq(issueDocuments.key, key),
          eq(documentRevisions.id, revisionId),
        ))
        .then((rows) => rows[0] ?? null);
    }

    return db
      .select({
        issueId: issueDocuments.issueId,
        key: issueDocuments.key,
        title: documents.title,
        format: documents.format,
        body: documents.latestBody,
        revisionId: documents.latestRevisionId,
        revisionNumber: documents.latestRevisionNumber,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(
        eq(issueDocuments.companyId, companyId),
        eq(issueDocuments.issueId, issueId),
        eq(issueDocuments.key, key),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function getAttachment(companyId: string, attachmentId: string) {
    return db
      .select({
        id: issueAttachments.id,
        issueId: issueAttachments.issueId,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        originalFilename: assets.originalFilename,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .where(and(
        eq(issueAttachments.companyId, companyId),
        eq(issueAttachments.id, attachmentId),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function getExecutionWorkspace(companyId: string, executionWorkspaceId: string) {
    return db
      .select({
        id: executionWorkspaces.id,
        projectId: executionWorkspaces.projectId,
      })
      .from(executionWorkspaces)
      .where(and(
        eq(executionWorkspaces.companyId, companyId),
        eq(executionWorkspaces.id, executionWorkspaceId),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function resolveItem(
    item: ReviewedArtifactItem,
    context: {
      companyId: string;
      actorType: ReviewedArtifactActorType;
      approvalPayload?: Record<string, unknown> | null;
      contextIssueId?: string | null;
    },
  ): Promise<{ artifact: ReviewedArtifactResolved; error?: ReviewedArtifactError }> {
    if (item.source.type === "unresolved") {
      return {
        artifact: withBaseResolvedArtifact(item, {
          title: defaultArtifactTitle(item, "Missing reviewed artifact"),
          resolution: missingResolution(
            `Stored artifact reference is incomplete: ${item.source.missingFields.join(", ")}`,
          ),
          preview: unsupportedPreview(),
          snapshot: {
            ...(item.metadata ?? {}),
            originalType: item.source.originalType,
            missingFields: item.source.missingFields,
          },
        }),
      };
    }

    switch (item.source.type) {
      case "issue_document": {
        const [sourceIssue, document] = await Promise.all([
          getIssueSummary(context.companyId, item.source.issueId),
          getDocumentVersion(
            context.companyId,
            item.source.issueId,
            item.source.documentKey,
            item.source.revisionId ?? null,
          ),
        ]);
        if (!document) {
          return {
            artifact: withBaseResolvedArtifact(item, {
              sourceIssue: toIssueSummary(sourceIssue),
              title: defaultArtifactTitle(item, `${item.source.documentKey} document`),
              resolution: missingResolution("Issue document not found."),
              preview: unsupportedPreview(),
              document: {
                key: item.source.documentKey,
                revisionId: item.source.revisionId ?? null,
                revisionNumber: null,
              },
            }),
          };
        }
        if (isLikelyMarkdownFormat(document.format)) {
          if (isInlinePreviewTooLarge(document.body)) {
            return {
              artifact: withBaseResolvedArtifact(item, {
                sourceIssue: toIssueSummary(sourceIssue),
                title: defaultArtifactTitle(item, document.title ?? `${document.key} document`),
                resolution: tooLargeResolution("Document body exceeded the inline preview limit."),
                preview: unsupportedPreview(),
                document: {
                  key: document.key,
                  revisionId: document.revisionId,
                  revisionNumber: document.revisionNumber,
                },
                snapshot: {
                  ...(item.metadata ?? {}),
                  format: document.format,
                },
              }),
            };
          }
          return {
            artifact: withBaseResolvedArtifact(item, {
              sourceIssue: toIssueSummary(sourceIssue),
              title: defaultArtifactTitle(item, document.title ?? `${document.key} document`),
              preview: markdownPreview(document.body),
              document: {
                key: document.key,
                revisionId: document.revisionId,
                revisionNumber: document.revisionNumber,
              },
              snapshot: {
                ...(item.metadata ?? {}),
                format: document.format,
              },
            }),
          };
        }

        return {
          artifact: withBaseResolvedArtifact(item, {
            sourceIssue: toIssueSummary(sourceIssue),
            title: defaultArtifactTitle(item, document.title ?? `${document.key} document`),
            preview: unsupportedPreview(),
            document: {
              key: document.key,
              revisionId: document.revisionId,
              revisionNumber: document.revisionNumber,
            },
            snapshot: {
              ...(item.metadata ?? {}),
              format: document.format,
            },
          }),
        };
      }

      case "issue_attachment": {
        const [sourceIssue, attachment] = await Promise.all([
          getIssueSummary(context.companyId, item.source.issueId),
          getAttachment(context.companyId, item.source.attachmentId),
        ]);
        if (!attachment) {
          return {
            artifact: withBaseResolvedArtifact(item, {
              sourceIssue: toIssueSummary(sourceIssue),
              title: defaultArtifactTitle(item, "Missing attachment"),
              resolution: missingResolution("Issue attachment not found."),
              preview: unsupportedPreview(),
            }),
          };
        }

        const contentType = normalizeContentType(attachment.contentType);
        const contentPath = `/api/attachments/${attachment.id}/content`;
        const resolution =
          contentType === SVG_CONTENT_TYPE
            ? resolvedResolution("SVG is download-only.")
            : resolvedResolution();

        let preview: ReviewedArtifactPreview;
        if (isImageContentType(contentType)) {
          preview = imagePreview(contentPath, contentType, attachment.byteSize);
        } else {
          preview = downloadPreview(`${contentPath}?download=1`, contentType, attachment.byteSize);
        }

        return {
          artifact: withBaseResolvedArtifact(item, {
            sourceIssue: toIssueSummary(sourceIssue),
            title: defaultArtifactTitle(item, attachment.originalFilename ?? "Issue attachment"),
            resolution,
            preview,
            snapshot: {
              ...(item.metadata ?? {}),
              originalFilename: attachment.originalFilename,
            },
          }),
        };
      }

      case "issue_work_product": {
        const [sourceIssue, workProduct] = await Promise.all([
          getIssueSummary(context.companyId, item.source.issueId),
          workProducts.getById(item.source.workProductId),
        ]);
        if (!workProduct || workProduct.companyId !== context.companyId) {
          return {
            artifact: withBaseResolvedArtifact(item, {
              sourceIssue: toIssueSummary(sourceIssue),
              title: defaultArtifactTitle(item, "Missing work product"),
              resolution: missingResolution("Issue work product not found."),
              preview: unsupportedPreview(),
            }),
          };
        }

        const suggestedArtifact = buildSuggestedArtifactFromWorkProduct(
          sourceIssue ?? {
            id: item.source.issueId,
            identifier: null,
            title: "Linked issue",
            executionWorkspaceId: null,
          },
          workProduct,
          item.orderIndex,
        );
        return {
          artifact: {
            ...suggestedArtifact,
            id: item.id,
            title: item.title ?? suggestedArtifact.title,
            description: item.description ?? suggestedArtifact.description,
            sortOrder: item.orderIndex,
            isPrimary: item.isPrimary,
            required: item.required,
            selectedExplicitly: item.selectedExplicitly,
            snapshot: {
              ...(suggestedArtifact.snapshot ?? {}),
              ...(item.metadata ?? {}),
            },
          },
        };
      }

      case "external_url": {
        const hostname = safeUrlHostname(item.source.url);
        return {
          artifact: withBaseResolvedArtifact(item, {
            title: defaultArtifactTitle(item, hostname ?? item.source.url),
            preview: linkPreview(item.source.url),
            snapshot: {
              ...(item.metadata ?? {}),
              provider: hostname,
            },
          }),
        };
      }

      case "approval_payload": {
        if (!context.approvalPayload) {
          return {
            artifact: withBaseResolvedArtifact(item, {
              title: defaultArtifactTitle(item, "Approval payload"),
              resolution: unavailableResolution("Approval payload sources require an approval context."),
              preview: unsupportedPreview(),
            }),
          };
        }

        const resolved = resolveJsonPointerValue(context.approvalPayload, item.source.pointer);
        if (!resolved.found) {
          return {
            artifact: withBaseResolvedArtifact(item, {
              title: defaultArtifactTitle(item, "Approval payload"),
              resolution: missingResolution(`Approval payload pointer ${item.source.pointer} was not found.`),
              preview: unsupportedPreview(),
            }),
          };
        }

        if (item.displayHint === "link" && typeof resolved.value === "string") {
          return {
            artifact: withBaseResolvedArtifact(item, {
              title: defaultArtifactTitle(item, safeUrlHostname(resolved.value) ?? "Approval link"),
              preview: linkPreview(resolved.value),
              snapshot: {
                ...(item.metadata ?? {}),
                pointer: item.source.pointer,
              },
            }),
          };
        }

        const { preview, resolution } = textPreviewFromValue(resolved.value);
        return {
          artifact: withBaseResolvedArtifact(item, {
            title: defaultArtifactTitle(item, "Approval payload"),
            resolution,
            preview,
            sourceIssue: context.contextIssueId
              ? toIssueSummary(await getIssueSummary(context.companyId, context.contextIssueId))
              : null,
            snapshot: {
              ...(item.metadata ?? {}),
              pointer: item.source.pointer,
            },
          }),
        };
      }

      case "workspace_file": {
        const sourceIssue = await getIssueSummary(context.companyId, item.source.issueId);
        if (context.actorType !== "board") {
          return {
            artifact: withBaseResolvedArtifact(item, {
              sourceIssue: toIssueSummary(sourceIssue),
              title: defaultArtifactTitle(item, item.source.path.split("/").pop() ?? "Workspace file"),
              resolution: permissionDeniedResolution("Workspace file previews require board access."),
              preview: unsupportedPreview(),
            }),
          };
        }

        const workspace = await getExecutionWorkspace(context.companyId, item.source.executionWorkspaceId);
        if (!workspace) {
          return {
            artifact: withBaseResolvedArtifact(item, {
              sourceIssue: toIssueSummary(sourceIssue),
              title: defaultArtifactTitle(item, item.source.path.split("/").pop() ?? "Workspace file"),
              resolution: missingResolution("Execution workspace not found."),
              preview: unsupportedPreview(),
            }),
          };
        }

        const params = new URLSearchParams({
          path: item.source.path,
          workspaceId: workspace.id,
          download: "1",
        });
        if (workspace.projectId) params.set("projectId", workspace.projectId);
        else params.delete("workspaceId");
        if (!workspace.projectId) params.set("workspace", "execution");

        return {
          artifact: withBaseResolvedArtifact(item, {
            sourceIssue: toIssueSummary(sourceIssue),
            title: defaultArtifactTitle(item, item.source.path.split("/").pop() ?? "Workspace file"),
            preview: downloadPreview(
              `/api/issues/${encodeURIComponent(item.source.issueId)}/file-resources/content?${params.toString()}`,
              extensionToContentType(fileExtension(item.source.path)),
              null,
            ),
            snapshot: {
              ...(item.metadata ?? {}),
              path: item.source.path,
              executionWorkspaceId: item.source.executionWorkspaceId,
              runId: item.source.runId ?? null,
            },
          }),
        };
      }
    }

    return {
      artifact: withBaseResolvedArtifact(item, {
        title: defaultArtifactTitle(item, "Unsupported reviewed artifact"),
        resolution: unavailableResolution(`Unsupported reviewed artifact source type: ${item.sourceType}`),
        preview: unsupportedPreview(),
      }),
      error: {
        source: item.sourceType,
        message: `Unsupported reviewed artifact source type: ${item.sourceType}`,
      },
    };
  }

  async function resolvePersistedSet(
    set: ReviewedArtifactSet,
    context: {
      companyId: string;
      actorType: ReviewedArtifactActorType;
      approvalPayload?: Record<string, unknown> | null;
      contextIssueId?: string | null;
    },
  ): Promise<ReviewedArtifactsResponse> {
    const artifacts: ReviewedArtifactResolved[] = [];
    const errors: ReviewedArtifactError[] = [];

    for (const item of set.items) {
      try {
        const resolved = await resolveItem(item, {
          ...context,
          contextIssueId: context.contextIssueId ?? set.contextIssueId ?? null,
        });
        artifacts.push(resolved.artifact);
        if (resolved.error) errors.push(resolved.error);
      } catch (error) {
        artifacts.push(withBaseResolvedArtifact(item, {
          title: defaultArtifactTitle(item, "Unavailable reviewed artifact"),
          resolution: unavailableResolution("Failed to resolve reviewed artifact."),
          preview: unsupportedPreview(),
        }));
        errors.push({
          source: item.sourceType,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      contextType: set.contextType,
      artifacts,
      errors,
    };
  }

  async function buildSuggestedIssueArtifacts(
    issue: IssueSummaryRow,
  ): Promise<ReviewedArtifactsResponse> {
    const artifacts = (await workProducts.listForIssue(issue.id))
      .filter((workProduct) => workProduct.reviewState === "needs_board_review")
      .map((workProduct, index) => buildSuggestedArtifactFromWorkProduct(issue, workProduct, index));

    return {
      contextType: "issue_review",
      artifacts,
      errors: [],
    };
  }

  return {
    async getForIssue(input: {
      companyId: string;
      issueId: string;
      actorType: ReviewedArtifactActorType;
    }): Promise<ReviewedArtifactsResponse> {
      const activeSet = await reviewedArtifacts.getActiveForIssueReview(input.companyId, input.issueId);
      if (activeSet) {
        return resolvePersistedSet(activeSet, input);
      }

      const issue = await getIssueSummary(input.companyId, input.issueId);
      if (!issue) {
        return { contextType: "issue_review", artifacts: [], errors: [] };
      }
      return buildSuggestedIssueArtifacts(issue);
    },

    async getForApproval(input: {
      companyId: string;
      approvalId: string;
      approvalPayload: Record<string, unknown> | null;
      actorType: ReviewedArtifactActorType;
    }): Promise<ReviewedArtifactsResponse> {
      const activeSet = await reviewedArtifacts.getActiveForApproval(input.companyId, input.approvalId);
      if (activeSet) {
        return resolvePersistedSet(activeSet, {
          ...input,
          contextIssueId: activeSet.contextIssueId ?? null,
        });
      }

      const linkedIssues = await issueApprovals.listIssuesForApproval(input.approvalId);
      const artifactGroups = await Promise.all(linkedIssues.map(async (issue) => {
        const issueSummary = await getIssueSummary(input.companyId, issue.id);
        if (!issueSummary) return [];
        const response = await buildSuggestedIssueArtifacts(issueSummary);
        return response.artifacts;
      }));

      return {
        contextType: "approval",
        artifacts: artifactGroups.flat(),
        errors: [],
      };
    },
  };
}

function extensionToContentType(extension: string): string | null {
  switch (extension) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "json":
      return "application/json";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    default:
      return null;
  }
}
