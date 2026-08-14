import { GitLabClient, encodeProjectId } from "../gitlab-client.js";

export interface GitLabCiOptions {
  readonly projectId: string | number;
  readonly token: string;
  readonly baseUrl?: string;
}

export interface GitLabPipeline {
  readonly id: number;
  readonly iid: number;
  readonly status: string;
  readonly ref: string;
  readonly sha: string;
  readonly web_url: string;
}

export class GitLabCiProvider {
  private readonly client: GitLabClient;
  private readonly project: string;

  public constructor(options: GitLabCiOptions) {
    this.client = new GitLabClient({
      token: options.token,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    });
    this.project = encodeProjectId(options.projectId);
  }

  public currentContext(env: NodeJS.ProcessEnv = process.env): Record<string, string> | null {
    if (env.CI_PIPELINE_ID === undefined) return null;
    return {
      pipelineId: env.CI_PIPELINE_ID,
      jobId: env.CI_JOB_ID ?? "",
      projectId: env.CI_PROJECT_ID ?? "",
      revision: env.CI_COMMIT_SHA ?? "",
      ref: env.CI_COMMIT_REF_NAME ?? "",
      serverUrl: env.CI_SERVER_URL ?? "",
    };
  }

  public async submit(
    ref: string,
    variables: Readonly<Record<string, string>> = {},
  ): Promise<GitLabPipeline> {
    return this.client.requestJson<GitLabPipeline>(
      "POST",
      `/projects/${this.project}/pipeline`,
      {
        ref,
        variables: Object.entries(variables).map(([key, value]) => ({ key, value })),
      },
    );
  }

  public async get(pipelineId: number): Promise<GitLabPipeline> {
    return this.client.requestJson<GitLabPipeline>(
      "GET",
      `/projects/${this.project}/pipelines/${pipelineId}`,
    );
  }

  public async cancel(pipelineId: number): Promise<GitLabPipeline> {
    return this.client.requestJson<GitLabPipeline>(
      "POST",
      `/projects/${this.project}/pipelines/${pipelineId}/cancel`,
    );
  }

  public async jobs(pipelineId: number): Promise<readonly Record<string, unknown>[]> {
    return this.client.requestJson<readonly Record<string, unknown>[]>(
      "GET",
      `/projects/${this.project}/pipelines/${pipelineId}/jobs`,
      undefined,
      { per_page: 100 },
    );
  }

  public async downloadJobArtifacts(jobId: number): Promise<Uint8Array> {
    return this.client.requestBytes(
      "GET",
      `/projects/${this.project}/jobs/${jobId}/artifacts`,
    );
  }
}
