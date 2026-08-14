import { createHash } from "node:crypto";

import { GitLabClient, encodeProjectId } from "../gitlab-client.js";
import { parseUnifiedDiff } from "../../repair.js";
import { runProcess } from "../../process.js";

export interface GitLabChangePublisherOptions {
  readonly projectId: string | number;
  readonly token: string;
  readonly workspacePath: string;
  readonly baseUrl?: string;
  readonly remote?: string;
  readonly targetBranch?: string;
  readonly authorName?: string;
  readonly authorEmail?: string;
}

export interface PublishDraftRequest {
  readonly baseRevision: string;
  readonly patchText: string;
  readonly title: string;
  readonly description: string;
  readonly idempotencyKey: string;
}

export interface PublishedChange {
  readonly changeId: string;
  readonly url: string;
  readonly branch: string;
  readonly created: boolean;
}

interface MergeRequest {
  readonly iid: number;
  readonly web_url: string;
  readonly source_branch: string;
}

export class GitLabChangePublisher {
  private readonly client: GitLabClient;
  private readonly project: string;

  public constructor(private readonly options: GitLabChangePublisherOptions) {
    this.client = new GitLabClient({
      token: options.token,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    });
    this.project = encodeProjectId(options.projectId);
  }

  public async publishDraft(request: PublishDraftRequest): Promise<PublishedChange> {
    const branch = `hypertest/${slug(request.idempotencyKey).slice(0, 48) || digest(request.idempotencyKey)}`;
    const existing = await this.findByBranch(branch);
    if (existing !== undefined) {
      return {
        changeId: String(existing.iid),
        url: existing.web_url,
        branch,
        created: false,
      };
    }

    await this.assertCleanWorkspace();
    const changedPaths = parseUnifiedDiff(request.patchText).paths;
    if (changedPaths.length === 0) throw new Error("Cannot publish an empty patch");
    await this.git(["checkout", "--detach", request.baseRevision]);
    await this.git(["switch", "-c", branch]);
    await this.git(["apply", "--whitespace=nowarn", "-"], request.patchText);
    await this.git(["add", "--", ...changedPaths]);
    await this.git(
      [
        "-c",
        `user.name=${this.options.authorName ?? "HyperTest"}`,
        "-c",
        `user.email=${this.options.authorEmail ?? "hypertest@users.noreply.github.com"}`,
        "commit",
        "-m",
        request.title,
      ],
    );
    await this.git(["push", "-u", this.options.remote ?? "origin", `HEAD:${branch}`]);

    const created = await this.client.requestJson<MergeRequest>(
      "POST",
      `/projects/${this.project}/merge_requests`,
      {
        source_branch: branch,
        target_branch: this.options.targetBranch ?? "main",
        title: request.title,
        description: request.description,
        draft: true,
        remove_source_branch: true,
      },
    );
    return {
      changeId: String(created.iid),
      url: created.web_url,
      branch,
      created: true,
    };
  }

  private async findByBranch(branch: string): Promise<MergeRequest | undefined> {
    const results = await this.client.requestJson<readonly MergeRequest[]>(
      "GET",
      `/projects/${this.project}/merge_requests`,
      undefined,
      { state: "opened", source_branch: branch, per_page: 20 },
    );
    return results[0];
  }

  private async assertCleanWorkspace(): Promise<void> {
    const result = await this.git(["status", "--porcelain"]);
    if (result.stdout.trim().length > 0) {
      throw new Error("Change publisher requires a clean scratch workspace");
    }
  }

  private async git(args: readonly string[], stdin?: string) {
    const result = await runProcess({
      command: "git",
      args,
      cwd: this.options.workspacePath,
      timeoutMs: 120_000,
      maxOutputBytes: 4 * 1024 * 1024,
      ...(stdin === undefined ? {} : { stdin }),
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
