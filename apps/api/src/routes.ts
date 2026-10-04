import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { analyzeRepository } from '@breadcrumb/analyzer';
import { buildProjectState } from '@breadcrumb/dependency-engine';
import { getGitSummary, getNewCommitsSince } from '@breadcrumb/git-engine';
import { createGemmaClient, inferProjectGoal, generateExplanation } from '@breadcrumb/gemma';
import { selectBreadcrumb, calculateProjectHealth, verifyTaskCompletion } from '@breadcrumb/task-engine';
import type { ProjectState, DependencyGraph, ProjectHealth, BreadcrumbTask, AgentRun, AgentStep } from '@breadcrumb/shared';
import * as db from './db.js';

export const router = Router();

const gemmaClient = createGemmaClient({
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  model: process.env.GEMMA_MODEL || 'gemma3:12b',
});

// ─── POST /api/projects/analyze ──────────────────────────────────────────────

router.post('/projects/analyze', async (req: Request, res: Response) => {
  const { projectPath, projectGoal } = req.body;

  if (!projectPath) {
    return res.status(400).json({ error: 'projectPath is required' });
  }

  const agentRun: AgentRun = {
    id: randomUUID(),
    projectId: '',
    startedAt: new Date(),
    steps: [],
  };

  try {
    // Step 1: Analyze repository
    const scanStep = startStep('repository_scan');
    const analysis = await analyzeRepository(projectPath);
    endStep(scanStep, agentRun);

    // Step 2: Git summary
    const gitStep = startStep('git_analysis');
    const gitSummary = getGitSummary(projectPath);
    endStep(gitStep, agentRun);

    // Step 3: Infer project goal if not provided
    let name = analysis.readme?.title || projectPath.split('/').pop() || 'Unknown Project';
    let goal = projectGoal || '';

    if (!goal) {
      const goalStep = startStep('goal_inference');
      try {
        const flatFiles = flattenFileTree(analysis.fileTree);
        const goalResult = await inferProjectGoal(
          gemmaClient,
          analysis.readme?.rawContent || null,
          analysis.packageFiles[0]?.name || null,
          flatFiles.map(f => f.path),
          analysis.languages.map(l => l.language)
        );
        name = goalResult.name || name;
        goal = goalResult.goal || 'Build and complete this project';
      } catch (err) {
        goal = analysis.readme?.description || 'Build and complete this project';
      }
      endStep(goalStep, agentRun);
    }

    // Step 4: Build project state and dependency graph
    const stateStep = startStep('state_building');
    const { state, graph } = buildProjectState(analysis, name, goal);

    // Add git info to recent changes
    state.recentChanges = gitSummary.recentChanges;
    endStep(stateStep, agentRun);

    // Step 5: Calculate health
    const healthStep = startStep('health_calculation');
    const health = calculateProjectHealth(state);
    endStep(healthStep, agentRun);

    // Step 6: Select breadcrumb
    const breadcrumbStep = startStep('breadcrumb_selection');

    // Get or create project in DB
    let project = await db.getProjectByPath(projectPath);
    if (!project) {
      project = await db.createProject({
        name,
        goal,
        path: projectPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } else {
      await db.updateProject(project.id, { name, goal, lastAnalyzedAt: new Date() });
    }

    agentRun.projectId = project.id;

    const previousTasks = await db.getTaskHistory(project.id, 5);
    const breadcrumb = await selectBreadcrumb(state, graph, gemmaClient, project.id, previousTasks);
    endStep(breadcrumbStep, agentRun);

    // Step 7: Save everything to MongoDB
    const saveStep = startStep('data_persistence');
    await db.saveSnapshot(project.id, state, graph, health, gitSummary.currentCommit);
    await db.saveTask(breadcrumb);
    await db.addTimelineEntry({
      projectId: project.id,
      timestamp: new Date(),
      type: 'repository_analyzed',
      title: 'Repository analyzed',
      detail: `${analysis.totalFiles} files, ${analysis.languages.length} languages detected`,
    });
    await db.addTimelineEntry({
      projectId: project.id,
      timestamp: new Date(),
      type: 'dependency_graph_generated',
      title: 'Dependency graph generated',
      detail: `${graph.nodes.length} nodes, ${graph.edges.length} edges`,
    });
    await db.addTimelineEntry({
      projectId: project.id,
      timestamp: new Date(),
      type: 'breadcrumb_selected',
      title: `Breadcrumb selected: ${breadcrumb.title}`,
      detail: breadcrumb.why,
    });
    endStep(saveStep, agentRun);

    // Finalize agent run
    agentRun.completedAt = new Date();
    agentRun.result = breadcrumb;
    await db.saveAgentRun(agentRun);

    res.json({
      project: { ...project, name, goal },
      state,
      graph,
      breadcrumb,
      health,
      agentRunId: agentRun.id,
      git: {
        branch: gitSummary.branch,
        currentCommit: gitSummary.currentCommit,
        uncommittedChanges: gitSummary.uncommittedChanges.length,
      },
    });

  } catch (err: any) {
    agentRun.completedAt = new Date();
    agentRun.error = err.message;
    try { await db.saveAgentRun(agentRun); } catch { /* ignore */ }

    console.error('Analysis failed:', err);
    res.status(500).json({
      error: 'Analysis failed',
      message: err.message,
      suggestion: 'Ensure the project path exists and Ollama/Gemma is running',
    });
  }
});

// ─── GET /api/projects ───────────────────────────────────────────────────────

router.get('/projects', async (_req: Request, res: Response) => {
  try {
    const projects = await db.listProjects();
    res.json(projects);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/projects/:id ───────────────────────────────────────────────────

router.get('/projects/:id', async (req: Request, res: Response) => {
  try {
    const project = await db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const snapshot = await db.getLatestSnapshot(project.id);
    const activeTask = await db.getActiveTask(project.id);

    res.json({
      project,
      state: snapshot?.state || null,
      graph: snapshot?.graph || null,
      health: snapshot?.health || null,
      breadcrumb: activeTask,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/projects/:id/health ────────────────────────────────────────────

router.get('/projects/:id/health', async (req: Request, res: Response) => {
  try {
    const snapshot = await db.getLatestSnapshot(req.params.id);
    if (!snapshot) return res.status(404).json({ error: 'No analysis found' });
    res.json(snapshot.health);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/projects/:id/graph ─────────────────────────────────────────────

router.get('/projects/:id/graph', async (req: Request, res: Response) => {
  try {
    const snapshot = await db.getLatestSnapshot(req.params.id);
    if (!snapshot) return res.status(404).json({ error: 'No analysis found' });
    res.json(snapshot.graph);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/projects/:id/breadcrumb ────────────────────────────────────────

router.get('/projects/:id/breadcrumb', async (req: Request, res: Response) => {
  try {
    const task = await db.getActiveTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'No active breadcrumb' });
    res.json(task);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/projects/:id/breadcrumb/start ─────────────────────────────────

router.post('/projects/:id/breadcrumb/start', async (req: Request, res: Response) => {
  try {
    const task = await db.getActiveTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'No active breadcrumb' });

    await db.updateTaskStatus(task.id, 'active');
    await db.addTimelineEntry({
      projectId: req.params.id,
      timestamp: new Date(),
      type: 'breadcrumb_selected',
      title: `Started: ${task.title}`,
    });

    res.json({ ...task, status: 'active', startedAt: new Date() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/projects/:id/breadcrumb/complete ──────────────────────────────

router.post('/projects/:id/breadcrumb/complete', async (req: Request, res: Response) => {
  try {
    const project = await db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const task = await db.getActiveTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'No active breadcrumb' });

    // Re-analyze to verify
    const analysis = await analyzeRepository(project.path);
    const { state: newState, graph: newGraph } = buildProjectState(analysis, project.name, project.goal);
    const newHealth = calculateProjectHealth(newState);

    // Get previous state for verification
    const previousSnapshot = await db.getLatestSnapshot(project.id);
    let verificationResults;
    if (previousSnapshot) {
      verificationResults = verifyTaskCompletion(task, newState, previousSnapshot.state);
    }

    // Mark task as completed
    await db.updateTaskStatus(task.id, 'completed', verificationResults);

    // Save new snapshot
    const gitSummary = getGitSummary(project.path);
    await db.saveSnapshot(project.id, newState, newGraph, newHealth, gitSummary.currentCommit);

    await db.addTimelineEntry({
      projectId: project.id,
      timestamp: new Date(),
      type: 'breadcrumb_completed',
      title: `Completed: ${task.title}`,
      detail: verificationResults
        ? `${verificationResults.filter((v: any) => v.passed).length}/${verificationResults.length} checks passed`
        : undefined,
    });

    // Select next breadcrumb
    const previousTasks = await db.getTaskHistory(project.id, 10);
    const nextBreadcrumb = await selectBreadcrumb(newState, newGraph, gemmaClient, project.id, previousTasks);
    await db.saveTask(nextBreadcrumb);

    await db.addTimelineEntry({
      projectId: project.id,
      timestamp: new Date(),
      type: 'breadcrumb_selected',
      title: `Next breadcrumb: ${nextBreadcrumb.title}`,
      detail: nextBreadcrumb.why,
    });

    res.json({
      completed: {
        ...task,
        status: 'completed',
        completedAt: new Date(),
        verificationResults,
      },
      nextBreadcrumb,
      health: newHealth,
      state: newState,
      graph: newGraph,
    });
  } catch (err: any) {
    console.error('Completion failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/projects/:id/breadcrumb/explain ───────────────────────────────

router.post('/projects/:id/breadcrumb/explain', async (req: Request, res: Response) => {
  try {
    const project = await db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const task = await db.getActiveTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'No active breadcrumb' });

    const snapshot = await db.getLatestSnapshot(project.id);
    if (!snapshot) return res.status(404).json({ error: 'No project state' });

    const explanation = await generateExplanation(gemmaClient, task, snapshot.state);
    res.json(explanation);
  } catch (err: any) {
    console.error('Explanation failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/projects/:id/rescan ───────────────────────────────────────────

router.post('/projects/:id/rescan', async (req: Request, res: Response) => {
  try {
    const project = await db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const analysis = await analyzeRepository(project.path);
    const gitSummary = getGitSummary(project.path);
    const { state, graph } = buildProjectState(analysis, project.name, project.goal);
    state.recentChanges = gitSummary.recentChanges;
    const health = calculateProjectHealth(state);

    await db.saveSnapshot(project.id, state, graph, health, gitSummary.currentCommit);
    await db.updateProject(project.id, { lastAnalyzedAt: new Date() });

    await db.addTimelineEntry({
      projectId: project.id,
      timestamp: new Date(),
      type: 'rescan_triggered',
      title: 'Project rescanned',
      detail: `${analysis.totalFiles} files analyzed`,
    });

    // Check for new commits
    const previousSnapshot = await db.getLatestSnapshot(project.id);
    if (previousSnapshot?.commitHash && gitSummary.currentCommit !== previousSnapshot.commitHash) {
      const newCommits = getNewCommitsSince(project.path, previousSnapshot.commitHash);
      if (newCommits.length > 0) {
        await db.addTimelineEntry({
          projectId: project.id,
          timestamp: new Date(),
          type: 'commit_detected',
          title: `${newCommits.length} new commit(s) detected`,
          detail: newCommits.map(c => c.message).join(', '),
        });
      }
    }

    // Re-select breadcrumb
    const previousTasks = await db.getTaskHistory(project.id, 10);
    const breadcrumb = await selectBreadcrumb(state, graph, gemmaClient, project.id, previousTasks);
    await db.saveTask(breadcrumb);

    res.json({ project, state, graph, health, breadcrumb });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/projects/:id/history ───────────────────────────────────────────

router.get('/projects/:id/history', async (req: Request, res: Response) => {
  try {
    const timeline = await db.getTimeline(req.params.id);
    res.json(timeline);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/projects/:id/tasks ─────────────────────────────────────────────

router.get('/projects/:id/tasks', async (req: Request, res: Response) => {
  try {
    const tasks = await db.getTaskHistory(req.params.id);
    res.json(tasks);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health ─────────────────────────────────────────────────────────

router.get('/health', async (_req: Request, res: Response) => {
  const gemmaAvailable = await gemmaClient.isAvailable();
  res.json({
    status: 'ok',
    gemma: gemmaAvailable ? 'connected' : 'unavailable',
    timestamp: new Date().toISOString(),
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function flattenFileTree(nodes: any[]): any[] {
  const flat: any[] = [];
  function walk(list: any[]) {
    for (const n of list) {
      flat.push(n);
      if (n.children) walk(n.children);
    }
  }
  walk(nodes);
  return flat;
}

function startStep(name: string): AgentStep {
  return {
    name,
    startedAt: new Date(),
  };
}

function endStep(step: AgentStep, run: AgentRun): void {
  step.completedAt = new Date();
  step.durationMs = step.completedAt.getTime() - step.startedAt.getTime();
  run.steps.push(step);
}
