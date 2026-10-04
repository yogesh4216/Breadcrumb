// ─── Project Types ───────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  goal: string;
  path: string;
  createdAt: Date;
  updatedAt: Date;
  lastAnalyzedAt?: Date;
}

export interface ProjectSnapshot {
  id: string;
  projectId: string;
  timestamp: Date;
  state: ProjectState;
  commitHash?: string;
}

export interface ProjectState {
  project: {
    name: string;
    goal: string;
    languages: string[];
    frameworks: string[];
  };
  features: Feature[];
  modules: Module[];
  dependencies: Dependency[];
  completedWork: CompletedWork[];
  missingWork: MissingWork[];
  blockedWork: BlockedWork[];
  scopeRisks: ScopeRisk[];
  recentChanges: RecentChange[];
}

// ─── Module / Feature Types ──────────────────────────────────────────────────

export interface Feature {
  id: string;
  name: string;
  description: string;
  status: FeatureStatus;
  modules: string[];
  completionPercentage: number;
}

export type FeatureStatus = 'not_started' | 'in_progress' | 'completed' | 'blocked';

export interface Module {
  id: string;
  name: string;
  type: ModuleType;
  path: string;
  files: string[];
  status: ModuleStatus;
  evidence: Evidence[];
}

export type ModuleType =
  | 'model'
  | 'route'
  | 'controller'
  | 'service'
  | 'middleware'
  | 'component'
  | 'test'
  | 'config'
  | 'migration'
  | 'schema'
  | 'utility'
  | 'unknown';

export type ModuleStatus = 'complete' | 'partial' | 'skeleton' | 'missing' | 'broken';

// ─── Dependency Types ────────────────────────────────────────────────────────

export interface Dependency {
  id: string;
  from: string;        // module id
  to: string;          // module id
  type: DependencyType;
  evidence: Evidence[];
}

export type DependencyType =
  | 'imports'
  | 'calls'
  | 'extends'
  | 'requires'
  | 'configures'
  | 'tests'
  | 'renders'
  | 'routes_to';

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export interface DependencyNode {
  id: string;
  label: string;
  type: ModuleType;
  status: ModuleStatus;
  layer: number;       // 0 = bottom (database), higher = more downstream
  files: string[];
}

export interface DependencyEdge {
  source: string;
  target: string;
  type: DependencyType;
}

// ─── Work Status Types ───────────────────────────────────────────────────────

export interface CompletedWork {
  moduleId: string;
  name: string;
  completedAt?: Date;
  evidence: Evidence[];
}

export interface MissingWork {
  name: string;
  description: string;
  expectedType: ModuleType;
  referencedBy: string[];
  evidence: Evidence[];
}

export interface BlockedWork {
  moduleId: string;
  name: string;
  blockedBy: string[];
  reason: string;
}

// ─── Scope Risk Types ────────────────────────────────────────────────────────

export interface ScopeRisk {
  type: 'scope_expansion' | 'downstream_work' | 'unnecessary_polish' | 'missing_prerequisite';
  severity: 'low' | 'medium' | 'high';
  description: string;
  affectedModules: string[];
  recommendation: string;
}

// ─── Evidence Types ──────────────────────────────────────────────────────────

export interface Evidence {
  file: string;
  line?: number;
  reason: string;
  snippet?: string;
}

// ─── Task Types ──────────────────────────────────────────────────────────────

export interface BreadcrumbTask {
  id: string;
  projectId: string;
  title: string;
  why: string;
  evidence: Evidence[];
  prerequisites: string[];
  doneWhen: string[];
  estimatedMinutes: number;
  confidence: number;
  risk: 'low' | 'medium' | 'high';
  status: TaskStatus;
  score: TaskScore;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  verificationResults?: VerificationResult[];
}

export type TaskStatus = 'pending' | 'active' | 'completed' | 'verified' | 'skipped' | 'failed';

export interface TaskScore {
  total: number;
  unblocksOtherWork: number;
  prerequisitesCompleted: number;
  projectGoalRelevance: number;
  smallTaskSize: number;
  testability: number;
  confidence: number;
  riskPenalty: number;
  scopeExpansionPenalty: number;
}

export interface CandidateTask {
  title: string;
  why: string;
  evidence: Evidence[];
  prerequisites: string[];
  doneWhen: string[];
  estimatedMinutes: number;
  confidence: number;
  risk: 'low' | 'medium' | 'high';
  score: TaskScore;
}

export interface VerificationResult {
  check: string;
  passed: boolean;
  detail?: string;
}

// ─── Git Types ───────────────────────────────────────────────────────────────

export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: Date;
  changedFiles: string[];
}

export interface RecentChange {
  commitHash: string;
  message: string;
  date: Date;
  filesChanged: string[];
  summary: string;
}

// ─── Analyzer Types ──────────────────────────────────────────────────────────

export interface AnalyzerResult {
  fileTree: FileNode[];
  languages: LanguageInfo[];
  packageFiles: PackageInfo[];
  readme: ReadmeInfo | null;
  todoComments: TodoComment[];
  routes: RouteInfo[];
  imports: ImportInfo[];
  classes: ClassInfo[];
  functions: FunctionInfo[];
  tests: TestInfo[];
  configs: ConfigInfo[];
  envExample: EnvInfo | null;
  totalFiles: number;
  totalLines: number;
}

export interface FileNode {
  path: string;
  name: string;
  type: 'file' | 'directory';
  extension?: string;
  size?: number;
  children?: FileNode[];
}

export interface LanguageInfo {
  language: string;
  extensions: string[];
  fileCount: number;
  lineCount: number;
  percentage: number;
}

export interface PackageInfo {
  file: string;
  type: 'npm' | 'pip' | 'cargo' | 'go' | 'maven' | 'gradle' | 'other';
  name?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts?: Record<string, string>;
}

export interface ReadmeInfo {
  file: string;
  title?: string;
  description?: string;
  sections: string[];
  mentionedTechnologies: string[];
  rawContent: string;
}

export interface TodoComment {
  file: string;
  line: number;
  type: 'TODO' | 'FIXME' | 'HACK' | 'XXX' | 'BUG';
  text: string;
}

export interface RouteInfo {
  file: string;
  method: string;
  path: string;
  handler?: string;
  line: number;
}

export interface ImportInfo {
  file: string;
  line: number;
  source: string;
  specifiers: string[];
  isRelative: boolean;
}

export interface ClassInfo {
  file: string;
  name: string;
  line: number;
  methods: string[];
  extends?: string;
  implements?: string[];
}

export interface FunctionInfo {
  file: string;
  name: string;
  line: number;
  params: string[];
  isExported: boolean;
  isAsync: boolean;
}

export interface TestInfo {
  file: string;
  framework: 'jest' | 'mocha' | 'pytest' | 'unittest' | 'vitest' | 'unknown';
  testCases: string[];
  status: 'exists' | 'skeleton' | 'passing' | 'failing' | 'unknown';
}

export interface ConfigInfo {
  file: string;
  type: string;
  keys: string[];
}

export interface EnvInfo {
  file: string;
  variables: string[];
  missingRequired: string[];
}

// ─── API Types ───────────────────────────────────────────────────────────────

export interface AnalyzeRequest {
  projectPath: string;
  projectGoal?: string;
}

export interface AnalyzeResponse {
  project: Project;
  state: ProjectState;
  graph: DependencyGraph;
  breadcrumb: BreadcrumbTask;
  health: ProjectHealth;
}

export interface ProjectHealth {
  coreProgress: number;           // 0-100
  blockedTasks: number;
  unimplementedTasks: number;
  scopeRisks: number;
  failedTests: number;
  dependencyHealth: 'good' | 'warning' | 'critical';
  totalModules: number;
  completedModules: number;
}

export interface TimelineEntry {
  id: string;
  projectId: string;
  timestamp: Date;
  type: TimelineEventType;
  title: string;
  detail?: string;
}

export type TimelineEventType =
  | 'repository_analyzed'
  | 'dependency_graph_generated'
  | 'breadcrumb_selected'
  | 'commit_detected'
  | 'breadcrumb_completed'
  | 'breadcrumb_verified'
  | 'scope_warning'
  | 'downstream_warning'
  | 'rescan_triggered';

// ─── Agent Types ─────────────────────────────────────────────────────────────

export interface AgentRun {
  id: string;
  projectId: string;
  startedAt: Date;
  completedAt?: Date;
  steps: AgentStep[];
  result?: BreadcrumbTask;
  error?: string;
}

export interface AgentStep {
  name: string;
  tool?: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
}

// ─── Learning Mode Types ─────────────────────────────────────────────────────

export type LearningMode = 'guide' | 'hint' | 'explain';

export interface Hint {
  level: number;
  text: string;
}

export interface Explanation {
  concept: string;
  explanation: string;
  relevantFiles: string[];
  codeSnippets: { file: string; code: string; explanation: string }[];
}
