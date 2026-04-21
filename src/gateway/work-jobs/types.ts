export type WorkJobState =
  | "queued"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkJobResult = {
  content?: string;
  sessionKey?: string;
  turnId?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  thoughts?: string;
  thoughtsTruncated?: boolean;
  planTitles?: string[];
  items?: Array<{
    kind?: string;
    title?: string;
    status?: string;
    summary?: string;
    error?: string;
  }>;
  errors?: string[];
};

export type WorkJobInputs = {
  systemPrompt?: string;
  userMessage: string;
  messageChannel?: string;
  model?: string;
  sessionKey?: string;
  hiddenEnv?: Record<string, string>;
};

export type WorkJobRecord = {
  jobId: string;
  workContextId: string;
  state: WorkJobState;
  inputs: WorkJobInputs;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  leaseExpiresAt?: number;
  leaseToken?: string;
  attempts: number;
  error?: string;
  result?: WorkJobResult;
  slackPostedAt?: number;
};
