import { randomUUID } from 'node:crypto';
import type {
  ProjectState,
  DependencyGraph,
  CandidateTask,
  BreadcrumbTask,
  TaskScore,
  Evidence,
  Module,
  Dependency,
  ProjectHealth,
  VerificationResult,
} from '@breadcrumb/shared';
import { GemmaClient, reasonAboutNextTask } from '@breadcrumb/gemma';

// ─── Score Weights ───────────────────────────────────────────────────────────

const WEIGHTS = {
  unblocksOtherWork: 3.0,
  prerequisitesCompleted: 5.0,     // Critical: don't suggest tasks with incomplete prereqs
  projectGoalRelevance: 2.0,
  smallTaskSize: 1.5,
  testability: 1.0,
  confidence: 1.0,
  riskPenalty: 2.0,
  scopeExpansionPenalty: 3.0,
};

// ─── Generate Candidate Tasks ────────────────────────────────────────────────

export function generateCandidateTasks(
  state: ProjectState,
  graph: DependencyGraph
): CandidateTask[] {
  const candidates: CandidateTask[] = [];

  // 1. Tasks from missing work (highest priority candidates)
  for (const missing of state.missingWork) {
    const dependents = state.dependencies
      .filter(d => d.to === `mod_missing_${missing.name.replace(/[^a-zA-Z0-9]/g, '_')}`)
      .length;

    candidates.push({
      title: `Create the ${missing.name} module`,
      why: missing.description,
      evidence: missing.evidence,
      prerequisites: [],
      doneWhen: [
        `${missing.name} module/file exists`,
        'Module can be imported without errors',
        'Basic functionality works',
      ],
      estimatedMinutes: 30,
      confidence: 0.8,
      risk: 'low',
      score: scoreCandidate({
        unblocksCount: dependents,
        prerequisitesComplete: true,
        isGoalRelevant: true,
        estimatedMinutes: 30,
        hasTests: false,
        riskLevel: 'low',
        isScopeExpansion: false,
      }),
    });
  }

  // 2. Tasks from blocked work (need prereqs built first)
  for (const blocked of state.blockedWork) {
    // Create tasks for the missing prereqs
    for (const blockerId of blocked.blockedBy) {
      const blockerModule = state.modules.find(m => m.id === blockerId);
      if (!blockerModule || blockerModule.status === 'complete') continue;

      const existingCandidate = candidates.find(c =>
        c.title.toLowerCase().includes(blockerModule.name.toLowerCase())
      );
      if (existingCandidate) continue;

      const dependents = state.dependencies.filter(d => d.to === blockerId).length;

      candidates.push({
        title: `Complete the ${blockerModule.name} module`,
        why: `Required by ${blocked.name} and potentially other modules`,
        evidence: blockerModule.evidence,
        prerequisites: getModulePrerequisites(blockerModule, state),
        doneWhen: [
          `${blockerModule.name} is fully implemented`,
          'All imports resolve correctly',
          `${blocked.name} is no longer blocked by ${blockerModule.name}`,
        ],
        estimatedMinutes: estimateEffort(blockerModule),
        confidence: 0.75,
        risk: 'low',
        score: scoreCandidate({
          unblocksCount: dependents + 1,
          prerequisitesComplete: arePrerequisitesComplete(blockerModule, state),
          isGoalRelevant: true,
          estimatedMinutes: estimateEffort(blockerModule),
          hasTests: false,
          riskLevel: 'low',
          isScopeExpansion: false,
        }),
      });
    }
  }

  // 3. Tasks from partial modules (things started but not finished)
  for (const mod of state.modules) {
    if (mod.status !== 'partial' && mod.status !== 'skeleton') continue;

    const existingCandidate = candidates.find(c =>
      c.title.toLowerCase().includes(mod.name.toLowerCase())
    );
    if (existingCandidate) continue;

    const isBlocked = state.blockedWork.some(b => b.moduleId === mod.id);
    if (isBlocked) continue;

    const dependents = state.dependencies.filter(d => d.to === mod.id).length;
    const todos = mod.evidence.filter(e => e.reason.startsWith('TODO') || e.reason.startsWith('FIXME'));

    candidates.push({
      title: `Finish implementing ${mod.name}`,
      why: todos.length > 0
        ? `Contains ${todos.length} TODO/FIXME comments that need attention`
        : `Module ${mod.name} is partially implemented`,
      evidence: mod.evidence,
      prerequisites: getModulePrerequisites(mod, state),
      doneWhen: [
        `All TODO/FIXME comments in ${mod.name} are resolved`,
        'Module functions as expected',
        'No import errors',
      ],
      estimatedMinutes: estimateEffort(mod),
      confidence: 0.7,
      risk: 'low',
      score: scoreCandidate({
        unblocksCount: dependents,
        prerequisitesComplete: arePrerequisitesComplete(mod, state),
        isGoalRelevant: true,
        estimatedMinutes: estimateEffort(mod),
        hasTests: false,
        riskLevel: 'low',
        isScopeExpansion: false,
      }),
    });
  }

  // 4. Tasks from tests (skeleton or missing tests)
  for (const mod of state.modules) {
    if (mod.type !== 'test') continue;
    if (mod.status !== 'skeleton') continue;

    candidates.push({
      title: `Write tests for ${mod.name.replace(/test[_s]?/i, '')}`,
      why: `Test file exists but contains no meaningful test cases`,
      evidence: mod.evidence,
      prerequisites: [],
      doneWhen: [
        'At least one test case is implemented',
        'Tests can be run',
        'Tests pass',
      ],
      estimatedMinutes: 25,
      confidence: 0.65,
      risk: 'low',
      score: scoreCandidate({
        unblocksCount: 0,
        prerequisitesComplete: true,
        isGoalRelevant: true,
        estimatedMinutes: 25,
        hasTests: true,
        riskLevel: 'low',
        isScopeExpansion: false,
      }),
    });
  }

  // 5. Tasks from TODO/FIXME comments
  const todosByModule = new Map<string, typeof state.modules[0]['evidence']>();
  for (const mod of state.modules) {
    const todos = mod.evidence.filter(e =>
      e.reason.startsWith('TODO') || e.reason.startsWith('FIXME') || e.reason.startsWith('BUG')
    );
    if (todos.length > 0) {
      todosByModule.set(mod.id, todos);
    }
  }

  // Sort and return top candidates
  candidates.sort((a, b) => b.score.total - a.score.total);

  return candidates.slice(0, 10); // Top 10 candidates
}

// ─── Score a Candidate ───────────────────────────────────────────────────────

interface ScoreInput {
  unblocksCount: number;
  prerequisitesComplete: boolean;
  isGoalRelevant: boolean;
  estimatedMinutes: number;
  hasTests: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  isScopeExpansion: boolean;
}

function scoreCandidate(input: ScoreInput): TaskScore {
  const unblocksOtherWork = Math.min(input.unblocksCount / 3, 1); // Normalize 0-1
  const prerequisitesCompleted = input.prerequisitesComplete ? 1 : 0;
  const projectGoalRelevance = input.isGoalRelevant ? 1 : 0.3;
  const smallTaskSize = input.estimatedMinutes <= 30 ? 1 : input.estimatedMinutes <= 60 ? 0.7 : 0.4;
  const testability = input.hasTests ? 1 : 0.5;
  const confidence = prerequisitesCompleted * 0.8 + 0.2;
  const riskPenalty = input.riskLevel === 'low' ? 0 : input.riskLevel === 'medium' ? 0.3 : 0.7;
  const scopeExpansionPenalty = input.isScopeExpansion ? 0.8 : 0;

  const total =
    unblocksOtherWork * WEIGHTS.unblocksOtherWork +
    prerequisitesCompleted * WEIGHTS.prerequisitesCompleted +
    projectGoalRelevance * WEIGHTS.projectGoalRelevance +
    smallTaskSize * WEIGHTS.smallTaskSize +
    testability * WEIGHTS.testability +
    confidence * WEIGHTS.confidence -
    riskPenalty * WEIGHTS.riskPenalty -
    scopeExpansionPenalty * WEIGHTS.scopeExpansionPenalty;

  return {
    total,
    unblocksOtherWork,
    prerequisitesCompleted,
    projectGoalRelevance,
    smallTaskSize,
    testability,
    confidence,
    riskPenalty,
    scopeExpansionPenalty,
  };
}

// ─── Select One Breadcrumb ───────────────────────────────────────────────────

export async function selectBreadcrumb(
  state: ProjectState,
  graph: DependencyGraph,
  gemmaClient: GemmaClient,
  projectId: string,
  previousBreadcrumbs?: BreadcrumbTask[]
): Promise<BreadcrumbTask> {
  // Step 1: Generate candidates deterministically
  const candidates = generateCandidateTasks(state, graph);

  if (candidates.length === 0) {
    // No candidates — project might be complete or we can't determine tasks
    return {
      id: randomUUID(),
      projectId,
      title: 'Review project for completeness',
      why: 'No clear next tasks were identified. The project may be complete or needs manual review.',
      evidence: [],
      prerequisites: [],
      doneWhen: ['Review all modules', 'Confirm all features work', 'Run all tests'],
      estimatedMinutes: 30,
      confidence: 0.3,
      risk: 'low',
      status: 'pending',
      score: scoreCandidate({
        unblocksCount: 0,
        prerequisitesComplete: true,
        isGoalRelevant: true,
        estimatedMinutes: 30,
        hasTests: false,
        riskLevel: 'low',
        isScopeExpansion: false,
      }),
      createdAt: new Date(),
    };
  }

  // Step 2: Ask Gemma to reason about selection
  let gemmaResult;
  try {
    gemmaResult = await reasonAboutNextTask(gemmaClient, {
      projectState: state,
      dependencyGraph: graph,
      candidateTasks: candidates,
      previousBreadcrumbs,
    });
  } catch (err) {
    // Fallback to deterministic selection if Gemma fails
    console.warn('Gemma reasoning failed, falling back to deterministic selection:', err);
    
    const previousTitles = new Set((previousBreadcrumbs || []).map(t => t.title));
    const novelCandidates = candidates.filter(c => !previousTitles.has(c.title));
    const availableCandidates = novelCandidates.length > 0 ? novelCandidates : candidates;

    const topCandidate = availableCandidates.sort((a, b) => b.score.total - a.score.total)[0];
    return {
      id: randomUUID(),
      projectId,
      title: topCandidate.title,
      why: topCandidate.why,
      evidence: topCandidate.evidence,
      prerequisites: topCandidate.prerequisites,
      doneWhen: topCandidate.doneWhen,
      estimatedMinutes: topCandidate.estimatedMinutes,
      confidence: topCandidate.confidence * 0.8, // Lower confidence without Gemma
      risk: topCandidate.risk,
      status: 'pending',
      score: topCandidate.score,
      createdAt: new Date(),
    };
  }

  // Step 3: Build the breadcrumb from Gemma's reasoning
  const selectedCandidate = candidates[gemmaResult.selectedTaskIndex] || candidates[0];

  return {
    id: randomUUID(),
    projectId,
    title: gemmaResult.title || selectedCandidate.title,
    why: gemmaResult.why || selectedCandidate.why,
    evidence: gemmaResult.evidence.length > 0 ? gemmaResult.evidence : selectedCandidate.evidence,
    prerequisites: selectedCandidate.prerequisites,
    doneWhen: gemmaResult.doneWhen.length > 0 ? gemmaResult.doneWhen : selectedCandidate.doneWhen,
    estimatedMinutes: gemmaResult.estimatedMinutes || selectedCandidate.estimatedMinutes,
    confidence: gemmaResult.confidence,
    risk: gemmaResult.risk || selectedCandidate.risk,
    status: 'pending',
    score: selectedCandidate.score,
    createdAt: new Date(),
  };
}

// ─── Calculate Project Health ────────────────────────────────────────────────

export function calculateProjectHealth(state: ProjectState): ProjectHealth {
  const totalModules = state.modules.filter(m => m.type !== 'config' && m.type !== 'test').length;
  const completedModules = state.modules.filter(m =>
    m.status === 'complete' && m.type !== 'config' && m.type !== 'test'
  ).length;

  const coreProgress = totalModules > 0
    ? Math.round((completedModules / totalModules) * 100)
    : 0;

  const failedTests = state.modules
    .filter(m => m.type === 'test' && m.status === 'broken')
    .length;

  const blockedTasks = state.blockedWork.length;
  const unimplementedTasks = state.missingWork.length + state.modules.filter(m => m.status === 'skeleton').length;
  const scopeRisks = state.scopeRisks.length;

  let dependencyHealth: ProjectHealth['dependencyHealth'] = 'good';
  if (blockedTasks > totalModules * 0.5) dependencyHealth = 'critical';
  else if (blockedTasks > 0 || scopeRisks > 0) dependencyHealth = 'warning';

  return {
    coreProgress,
    blockedTasks,
    unimplementedTasks,
    scopeRisks,
    failedTests,
    dependencyHealth,
    totalModules,
    completedModules,
  };
}

// ─── Task Verification ───────────────────────────────────────────────────────

export function verifyTaskCompletion(
  task: BreadcrumbTask,
  currentState: ProjectState,
  previousState: ProjectState
): VerificationResult[] {
  const results: VerificationResult[] = [];

  // Check if referenced files now exist
  for (const evidence of task.evidence) {
    const moduleExists = currentState.modules.some(m =>
      m.files.includes(evidence.file) && m.status !== 'missing'
    );
    results.push({
      check: `File exists: ${evidence.file}`,
      passed: moduleExists,
      detail: moduleExists ? 'File found in project' : 'File not found',
    });
  }

  // Check if previously blocked work is now unblocked
  const previouslyBlocked = previousState.blockedWork.length;
  const currentlyBlocked = currentState.blockedWork.length;
  if (currentlyBlocked < previouslyBlocked) {
    results.push({
      check: 'Unblocked dependent tasks',
      passed: true,
      detail: `${previouslyBlocked - currentlyBlocked} tasks unblocked`,
    });
  }

  // Check if completion percentage changed
  const previousComplete = previousState.completedWork.length;
  const currentComplete = currentState.completedWork.length;
  results.push({
    check: 'Progress made',
    passed: currentComplete > previousComplete,
    detail: `Completed work: ${previousComplete} → ${currentComplete}`,
  });

  // Check general "done when" criteria (string matching heuristic)
  for (const criterion of task.doneWhen) {
    const lowerCriterion = criterion.toLowerCase();

    // Heuristic checks
    let passed = false;
    let detail = 'Could not automatically verify';

    if (lowerCriterion.includes('exists') || lowerCriterion.includes('file')) {
      // Check if mentioned file/module exists
      const mentions = currentState.modules.filter(m =>
        lowerCriterion.includes(m.name.toLowerCase())
      );
      passed = mentions.some(m => m.status !== 'missing');
      detail = passed ? 'Module/file found' : 'Module/file not found';
    }

    if (lowerCriterion.includes('test') && lowerCriterion.includes('pass')) {
      const testModules = currentState.modules.filter(m => m.type === 'test');
      const brokenTests = testModules.filter(m => m.status === 'broken');
      passed = brokenTests.length === 0;
      detail = passed ? 'No broken tests detected' : `${brokenTests.length} broken tests`;
    }

    if (lowerCriterion.includes('import')) {
      passed = true; // If we got this far without errors...
      detail = 'Import check requires runtime verification';
    }

    results.push({
      check: criterion,
      passed,
      detail,
    });
  }

  return results;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getModulePrerequisites(mod: Module, state: ProjectState): string[] {
  const deps = state.dependencies.filter(d => d.from === mod.id);
  return deps
    .map(d => state.modules.find(m => m.id === d.to))
    .filter((m): m is Module => m !== undefined && m.status !== 'complete')
    .map(m => m.name);
}

function arePrerequisitesComplete(mod: Module, state: ProjectState): boolean {
  const prereqs = getModulePrerequisites(mod, state);
  return prereqs.length === 0;
}

function estimateEffort(mod: Module): number {
  const fileCount = mod.files.length;
  const todos = mod.evidence.filter(e =>
    e.reason.startsWith('TODO') || e.reason.startsWith('FIXME')
  ).length;

  if (mod.status === 'missing') return 30;
  if (mod.status === 'skeleton') return 45;

  // Base on TODOs and file count
  return Math.min(Math.max(15, todos * 10 + fileCount * 5), 120);
}
