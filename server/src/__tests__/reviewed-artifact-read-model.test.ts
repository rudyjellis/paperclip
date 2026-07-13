import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  assets,
  companies,
  createDb,
  documentRevisions,
  documents,
  issueApprovals,
  issueAttachments,
  issueDocuments,
  issues,
  issueWorkProducts,
  reviewedArtifactItems,
  reviewedArtifactSets,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { reviewedArtifactReadModelService } from "../services/reviewed-artifact-read-model.js";
import { reviewedArtifactService } from "../services/reviewed-artifacts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reviewed artifact read-model tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("reviewedArtifactReadModelService", () => {
  let db!: ReturnType<typeof createDb>;
  let readModel!: ReturnType<typeof reviewedArtifactReadModelService>;
  let persistence!: ReturnType<typeof reviewedArtifactService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reviewed-artifact-read-model-");
    db = createDb(tempDb.connectionString);
    readModel = reviewedArtifactReadModelService(db);
    persistence = reviewedArtifactService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(reviewedArtifactItems);
    await db.delete(reviewedArtifactSets);
    await db.delete(issueApprovals);
    await db.delete(issueWorkProducts);
    await db.delete(issueAttachments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(assets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resolves persisted issue review selections into previewable artifacts", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const assetId = randomUUID();
    const attachmentId = randomUUID();
    const workProductId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review release assets",
      status: "in_review",
      priority: "high",
      identifier: "PAP-1759",
    });
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Launch plan",
      format: "markdown",
      latestBody: "# Launch plan\n\n- Capture screenshots",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Launch plan",
      format: "markdown",
      body: "# Launch plan\n\n- Capture screenshots",
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });
    await db.insert(assets).values({
      id: assetId,
      companyId,
      provider: "local_disk",
      objectKey: `issues/${issueId}/review.png`,
      contentType: "image/png",
      byteSize: 2048,
      sha256: "sha-attachment",
      originalFilename: "review.png",
    });
    await db.insert(issueAttachments).values({
      id: attachmentId,
      companyId,
      issueId,
      assetId,
    });
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Hosted preview",
      url: "https://example.com/preview",
      status: "ready_for_review",
      reviewState: "needs_board_review",
      metadata: {
        previewMode: "link",
        previewUrl: "https://example.com/preview",
        downloadUrl: "https://example.com/preview.zip",
        contentType: "text/html",
        byteSize: 512,
      },
    });

    await persistence.createSet({
      companyId,
      context: { type: "issue_review", issueId },
      title: "Board review packet",
      items: [
        {
          source: { type: "issue_document", issueId, documentKey: "plan", revisionId },
          title: "Release plan",
          displayHint: "markdown",
          selectedExplicitly: true,
          isPrimary: true,
        },
        {
          source: { type: "issue_attachment", issueId, attachmentId },
          title: "Preview image",
          displayHint: "image",
          selectedExplicitly: true,
        },
        {
          source: { type: "issue_work_product", issueId, workProductId },
          title: "Hosted preview",
          displayHint: "link",
          selectedExplicitly: true,
        },
      ],
    });

    const response = await readModel.getForIssue({
      companyId,
      issueId,
      actorType: "board",
    });

    expect(response.contextType).toBe("issue_review");
    expect(response.errors).toEqual([]);
    expect(response.artifacts).toHaveLength(3);
    expect(response.artifacts[0]).toEqual(expect.objectContaining({
      title: "Release plan",
      sourceType: "issue_document",
      preview: expect.objectContaining({
        mode: "markdown",
        previewable: true,
        markdownBody: expect.stringContaining("# Launch plan"),
      }),
      document: expect.objectContaining({
        key: "plan",
        revisionId,
        revisionNumber: 1,
      }),
    }));
    expect(response.artifacts[1]).toEqual(expect.objectContaining({
      title: "Preview image",
      sourceType: "issue_attachment",
      sourceIssue: expect.objectContaining({ identifier: "PAP-1759" }),
      preview: expect.objectContaining({
        mode: "image",
        previewable: true,
        previewUrl: `/api/attachments/${attachmentId}/content`,
      }),
    }));
    expect(response.artifacts[2]).toEqual(expect.objectContaining({
      title: "Hosted preview",
      sourceType: "issue_work_product",
      preview: expect.objectContaining({
        mode: "link",
        previewUrl: "https://example.com/preview",
        externalUrl: "https://example.com/preview",
      }),
      selectedExplicitly: true,
    }));
  });

  it("falls back to suggested issue work products when no explicit set exists", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Collect assets",
      status: "in_review",
      priority: "medium",
      identifier: "PAP-1761",
    });
    await db.insert(issueWorkProducts).values([
      {
        id: randomUUID(),
        companyId,
        issueId,
        type: "artifact",
        provider: "paperclip",
        title: "Screenshot bundle",
        status: "ready_for_review",
        reviewState: "needs_board_review",
        isPrimary: true,
        metadata: {
          previewMode: "download_only",
          downloadUrl: "https://example.com/screenshots.zip",
          contentType: "application/zip",
          byteSize: 4096,
        },
      },
      {
        id: randomUUID(),
        companyId,
        issueId,
        type: "artifact",
        provider: "paperclip",
        title: "Ignored draft",
        status: "draft",
        reviewState: "none",
      },
    ]);

    const response = await readModel.getForIssue({
      companyId,
      issueId,
      actorType: "board",
    });

    expect(response.contextType).toBe("issue_review");
    expect(response.errors).toEqual([]);
    expect(response.artifacts).toHaveLength(1);
    expect(response.artifacts[0]).toEqual(expect.objectContaining({
      id: expect.stringContaining("suggested-work-product:"),
      title: "Screenshot bundle",
      selectedExplicitly: false,
      sourceIssue: expect.objectContaining({ identifier: "PAP-1761" }),
      preview: expect.objectContaining({
        mode: "download_only",
        downloadUrl: "https://example.com/screenshots.zip",
      }),
    }));
  });

  it("falls back to linked issue suggestions for approvals without an explicit approval set", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const approvalId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Board-ready preview",
      status: "in_review",
      priority: "medium",
      identifier: "PAP-1762",
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { summary: "Approve the linked preview" },
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId,
      approvalId,
    });
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Linked preview",
      url: "https://example.com/approval-preview",
      status: "ready_for_review",
      reviewState: "needs_board_review",
      metadata: {
        previewMode: "link",
        previewUrl: "https://example.com/approval-preview",
      },
    });

    const response = await readModel.getForApproval({
      companyId,
      approvalId,
      approvalPayload: { summary: "Approve the linked preview" },
      actorType: "board",
    });

    expect(response.contextType).toBe("approval");
    expect(response.errors).toEqual([]);
    expect(response.artifacts).toHaveLength(1);
    expect(response.artifacts[0]).toEqual(expect.objectContaining({
      title: "Linked preview",
      selectedExplicitly: false,
      sourceIssue: expect.objectContaining({
        id: issueId,
        identifier: "PAP-1762",
      }),
      preview: expect.objectContaining({
        mode: "link",
        previewUrl: "https://example.com/approval-preview",
      }),
    }));
  });
});
