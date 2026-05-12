export type RequestType = "review" | "expand" | "tone";
export type ScenarioCategory =
  | "plot"
  | "character"
  | "worldbuilding"
  | "tone"
  | "pacing"
  | "dialogue"
  | "other";

export type SuggestionStatus = "pending" | "approved" | "rejected";
export type EditMode = "preserve" | "rewrite";

export interface DraftInput {
  chapterId: string;
  sectionId: string;
  draftText: string;
  worldMemo?: string;
  requestType: RequestType;
  category?: ScenarioCategory;
}

export interface ReviewerResult {
  reviewer: string;
  strengths: string[];
  concerns: string[];
  revisionDirection: string;
  revisedText?: string;
  changeLog?: string[];
  confidence?: number;
}

export interface AiReviewResult {
  strengths: string[];
  concerns: string[];
  finalText: string;
  suggestionText: string;
  changeReason: string;
  reviewSummary: string;
  reviewerResults: ReviewerResult[];
  usedModels: string[];
}
