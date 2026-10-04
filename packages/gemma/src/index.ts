import type {
  ProjectState,
  DependencyGraph,
  CandidateTask,
  Evidence,
  BreadcrumbTask,
  LearningMode,
  Hint,
  Explanation,
} from '@breadcrumb/shared';

// ─── Ollama Client ───────────────────────────────────────────────────────────

export interface GemmaConfig {
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

const DEFAULT_CONFIG: GemmaConfig = {
  baseUrl: 'http://localhost:11434',
  model: 'gemma3:12b',
  temperature: 0.3,
  maxTokens: 4096,
  timeout: 60000,
};

export function createGemmaClient(config: Partial<GemmaConfig> = {}): GemmaClient {
  return new GemmaClient({ ...DEFAULT_CONFIG, ...config });
}

export class GemmaClient {
  private config: GemmaConfig;

  constructor(config: GemmaConfig) {
    this.config = config;
  }

  // ─── Raw Completion ──────────────────────────────────────────────────

  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: { role: string; content: string }[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout || 60000);

    try {
      const response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
          options: {
            temperature: this.config.temperature,
            num_predict: this.config.maxTokens,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemma API error (${response.status}): ${errorText}`);
      }

      const data = await response.json() as { message?: { content?: string } };
      return data.message?.content || '';
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ─── Structured JSON Output ──────────────────────────────────────────

  async generateJSON<T>(prompt: string, systemPrompt?: string): Promise<T> {
    const jsonSystemPrompt = `${systemPrompt || ''}

CRITICAL: You MUST respond with valid JSON only. No markdown, no code fences, no explanation outside the JSON. Your entire response must be parseable as JSON.`;

    const response = await this.generate(prompt, jsonSystemPrompt);

    // Try to extract JSON from response
    let jsonStr = response.trim();

    // Remove markdown code fences if present
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```\s*$/, '');
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```\s*$/, '');
    }

    // Try to find JSON object/array boundaries
    const jsonStart = jsonStr.indexOf('{');
    const jsonEnd = jsonStr.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      jsonStr = jsonStr.substring(jsonStart, jsonEnd + 1);
    }

    try {
      return JSON.parse(jsonStr) as T;
    } catch (err) {
      throw new Error(`Failed to parse Gemma JSON response: ${err}\n\nRaw response:\n${response.slice(0, 500)}`);
    }
  }

  // ─── Health Check ────────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return false;
      const data = await response.json() as { models?: { name: string }[] };
      const models = data.models || [];
      return models.some((m: { name: string }) => m.name.includes('gemma'));
    } catch {
      return false;
    }
  }
}

// ─── System Prompt ───────────────────────────────────────────────────────────

export const BREADCRUMB_SYSTEM_PROMPT = `You are Breadcrumb, a project navigation AI.

Your job is NOT to generate an entire project.
Your job is NOT to write code.
Your job is to determine the smallest useful next action for the developer based on the current project state.

RULES:

1. Never return more than one primary next task.
2. Prefer tasks that unblock other tasks.
3. Never recommend a task whose prerequisites are incomplete.
4. Prefer small, concrete tasks (20-30 minutes of work).
5. Require observable completion criteria for every task.
6. Ground every recommendation in project evidence (specific files, lines, references).
7. Do not invent files or architecture that doesn't exist in the project evidence.
8. If uncertain, explicitly state uncertainty and lower your confidence score.
9. Protect the original project goal — do not encourage scope expansion.
10. Detect unnecessary scope expansion and warn about it.
11. Prefer helping the developer learn rather than doing everything.
12. Re-evaluate the project after meaningful changes.

EVIDENCE RULES:

- Every recommendation must cite specific files and reasons.
- Do not say "I think you should..." — say "Based on [evidence], the next step is..."
- If you cannot find evidence, say so and explain what's missing.
- Reference actual file paths, function names, and import statements from the project state.`;

// ─── Task Reasoning ──────────────────────────────────────────────────────────

interface TaskReasoningInput {
  projectState: ProjectState;
  dependencyGraph: DependencyGraph;
  candidateTasks: CandidateTask[];
  previousBreadcrumbs?: BreadcrumbTask[];
}

interface TaskReasoningOutput {
  selectedTaskIndex: number;
  title: string;
  why: string;
  evidence: Evidence[];
  doneWhen: string[];
  estimatedMinutes: number;
  confidence: number;
  risk: 'low' | 'medium' | 'high';
  reasoning: string;
  scopeWarning?: string;
  downstreamWarning?: string;
}

export async function reasonAboutNextTask(
  client: GemmaClient,
  input: TaskReasoningInput
): Promise<TaskReasoningOutput> {
  const prompt = buildTaskReasoningPrompt(input);

  const result = await client.generateJSON<TaskReasoningOutput>(
    prompt,
    BREADCRUMB_SYSTEM_PROMPT
  );

  // Validate the output
  if (result.selectedTaskIndex < 0 || result.selectedTaskIndex >= input.candidateTasks.length) {
    result.selectedTaskIndex = 0;
  }

  if (!result.confidence || result.confidence < 0 || result.confidence > 1) {
    result.confidence = 0.5;
  }

  if (!result.evidence || !Array.isArray(result.evidence)) {
    result.evidence = input.candidateTasks[result.selectedTaskIndex]?.evidence || [];
  }

  if (!result.doneWhen || !Array.isArray(result.doneWhen)) {
    result.doneWhen = input.candidateTasks[result.selectedTaskIndex]?.doneWhen || ['Task is completed'];
  }

  return result;
}

// ─── Build Reasoning Prompt ──────────────────────────────────────────────────

function buildTaskReasoningPrompt(input: TaskReasoningInput): string {
  const { projectState, dependencyGraph, candidateTasks, previousBreadcrumbs } = input;

  const stateSection = `
## PROJECT STATE

Project: ${projectState.project.name}
Goal: ${projectState.project.goal}
Languages: ${projectState.project.languages.join(', ')}
Frameworks: ${projectState.project.frameworks.join(', ')}

### Completed Work (${projectState.completedWork.length})
${projectState.completedWork.map(w => `- ✓ ${w.name}`).join('\n') || '- None'}

### Missing Work (${projectState.missingWork.length})
${projectState.missingWork.map(w => `- ✗ ${w.name}: ${w.description}`).join('\n') || '- None'}

### Blocked Work (${projectState.blockedWork.length})
${projectState.blockedWork.map(w => `- ⊘ ${w.name}: blocked by ${w.blockedBy.join(', ')} — ${w.reason}`).join('\n') || '- None'}

### Scope Risks (${projectState.scopeRisks.length})
${projectState.scopeRisks.map(r => `- ⚠ [${r.severity}] ${r.description}`).join('\n') || '- None'}

### Modules (${projectState.modules.length})
${projectState.modules.map(m => `- ${m.name} [${m.type}] (${m.status}) — ${m.files.length} files`).join('\n')}
`;

  const graphSection = `
## DEPENDENCY GRAPH

Nodes: ${dependencyGraph.nodes.length}
Edges: ${dependencyGraph.edges.length}

### Dependencies
${dependencyGraph.edges.map(e => {
  const source = dependencyGraph.nodes.find(n => n.id === e.source);
  const target = dependencyGraph.nodes.find(n => n.id === e.target);
  return `- ${source?.label || e.source} → ${target?.label || e.target} (${e.type})`;
}).join('\n') || '- None detected'}
`;

  const candidatesSection = `
## CANDIDATE TASKS (${candidateTasks.length})

${candidateTasks.map((t, i) => `
### Candidate ${i}: ${t.title}
- Why: ${t.why}
- Score: ${t.score.total.toFixed(2)}
  - Unblocks other work: ${t.score.unblocksOtherWork}
  - Prerequisites completed: ${t.score.prerequisitesCompleted}
  - Goal relevance: ${t.score.projectGoalRelevance}
  - Small task size: ${t.score.smallTaskSize}
  - Testability: ${t.score.testability}
  - Confidence: ${t.score.confidence}
  - Risk penalty: -${t.score.riskPenalty}
  - Scope expansion penalty: -${t.score.scopeExpansionPenalty}
- Evidence: ${t.evidence.map(e => `${e.file}: ${e.reason}`).join('; ')}
- Prerequisites: ${t.prerequisites.join(', ') || 'None'}
- Estimated: ${t.estimatedMinutes} minutes
`).join('\n')}`;

  const historySection = previousBreadcrumbs && previousBreadcrumbs.length > 0 ? `
## PREVIOUS BREADCRUMBS

${previousBreadcrumbs.slice(-5).map(b => `- ${b.status === 'completed' ? '✓' : '○'} ${b.title}`).join('\n')}
` : '';

  return `${stateSection}
${graphSection}
${candidatesSection}
${historySection}

## YOUR TASK

Select exactly ONE candidate task as the next breadcrumb.

Consider:
1. Which task unblocks the most other work?
2. Are all prerequisites for the selected task actually complete?
3. Is this task aligned with the project goal?
4. Is this the smallest useful next step?
5. Can the developer verify completion?

Respond with JSON:

{
  "selectedTaskIndex": <index of the selected candidate>,
  "title": "<refined task title>",
  "why": "<clear explanation of why this specific task is the best next step>",
  "evidence": [{"file": "<path>", "reason": "<why this file is relevant>"}],
  "doneWhen": ["<observable criterion 1>", "<criterion 2>"],
  "estimatedMinutes": <number>,
  "confidence": <0.0 to 1.0>,
  "risk": "<low|medium|high>",
  "reasoning": "<your chain of thought explaining the selection>",
  "scopeWarning": "<optional: warning if project scope is expanding>",
  "downstreamWarning": "<optional: warning if developer is working downstream>"
}`;
}

// ─── Project Goal Inference ──────────────────────────────────────────────────

interface GoalInferenceOutput {
  name: string;
  goal: string;
  confidence: number;
  reasoning: string;
}

export async function inferProjectGoal(
  client: GemmaClient,
  readmeContent: string | null,
  packageName: string | null,
  fileStructure: string[],
  languages: string[]
): Promise<GoalInferenceOutput> {
  const prompt = `Based on the following project information, infer the project name and goal.

README:
${readmeContent ? readmeContent.slice(0, 3000) : 'No README found'}

Package Name: ${packageName || 'Unknown'}

File Structure (sample):
${fileStructure.slice(0, 50).join('\n')}

Languages: ${languages.join(', ')}

Respond with JSON:
{
  "name": "<project name>",
  "goal": "<one sentence description of what this project is trying to build>",
  "confidence": <0.0 to 1.0>,
  "reasoning": "<brief explanation>"
}`;

  return client.generateJSON<GoalInferenceOutput>(prompt, BREADCRUMB_SYSTEM_PROMPT);
}

// ─── Learning Mode ───────────────────────────────────────────────────────────

export async function generateHints(
  client: GemmaClient,
  task: BreadcrumbTask,
  projectState: ProjectState,
  hintLevel: number
): Promise<Hint[]> {
  const prompt = `The developer is working on this task:

Task: ${task.title}
Why: ${task.why}

Project context:
${projectState.modules.map(m => `- ${m.name} (${m.type}, ${m.status})`).join('\n')}

Generate ${hintLevel} progressive hints (from subtle to specific).
Do NOT provide the full solution.

Respond with JSON:
{
  "hints": [
    {"level": 1, "text": "<very subtle hint>"},
    {"level": 2, "text": "<more specific hint>"},
    {"level": 3, "text": "<detailed hint without code>"}
  ]
}`;

  const result = await client.generateJSON<{ hints: Hint[] }>(prompt, BREADCRUMB_SYSTEM_PROMPT);
  return result.hints.slice(0, hintLevel);
}

export async function generateExplanation(
  client: GemmaClient,
  task: BreadcrumbTask,
  projectState: ProjectState
): Promise<Explanation> {
  const prompt = `The developer needs to understand this task:

Task: ${task.title}
Why: ${task.why}
Evidence: ${task.evidence.map(e => `${e.file}: ${e.reason}`).join('\n')}

Project modules:
${projectState.modules.map(m => `- ${m.name} (${m.type}, ${m.status})`).join('\n')}

Explain the relevant concepts and how they connect in this project.
Do NOT write the solution code.

Respond with JSON:
{
  "concept": "<main concept>",
  "explanation": "<beginner-friendly explanation>",
  "relevantFiles": ["<file1>", "<file2>"],
  "codeSnippets": [
    {"file": "<path>", "code": "<existing code snippet>", "explanation": "<what it does>"}
  ]
}`;

  return client.generateJSON<Explanation>(prompt, BREADCRUMB_SYSTEM_PROMPT);
}
