import type {
  AnalyzerResult,
  Module,
  ModuleType,
  ModuleStatus,
  Dependency,
  DependencyType,
  DependencyGraph,
  DependencyNode,
  DependencyEdge,
  Feature,
  CompletedWork,
  MissingWork,
  BlockedWork,
  ScopeRisk,
  Evidence,
  ProjectState,
} from '@breadcrumb/shared';

// ─── Layer Ordering ──────────────────────────────────────────────────────────

const LAYER_ORDER: Record<ModuleType, number> = {
  config: 0,
  migration: 1,
  schema: 1,
  model: 2,
  service: 3,
  middleware: 3,
  controller: 4,
  route: 4,
  utility: 3,
  component: 5,
  test: 6,
  unknown: 3,
};

// ─── Module Detection ────────────────────────────────────────────────────────

export function detectModules(analysis: AnalyzerResult): Module[] {
  const modules: Module[] = [];
  const filesByDir: Record<string, string[]> = {};

  // Group files by directory
  const flatFiles = flattenTree(analysis.fileTree);
  for (const file of flatFiles) {
    if (file.type !== 'file') continue;
    const dir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '.';
    if (!filesByDir[dir]) filesByDir[dir] = [];
    filesByDir[dir].push(file.path);
  }

  // Detect modules from directory structure
  for (const [dir, files] of Object.entries(filesByDir)) {
    const moduleType = inferModuleType(dir, files);
    const moduleName = dir === '.' ? 'root' : dir.split('/').pop() || dir;

    // Check if this directory constitutes a module
    const sourceFiles = files.filter(f => isSourceFile(f));
    if (sourceFiles.length === 0 && moduleType === 'unknown') continue;

    const status = inferModuleStatus(files, analysis);
    const evidence = gatherModuleEvidence(dir, files, analysis);

    modules.push({
      id: `mod_${dir.replace(/[^a-zA-Z0-9]/g, '_')}`,
      name: moduleName,
      type: moduleType,
      path: dir,
      files: sourceFiles,
      status,
      evidence,
    });
  }

  // Detect referenced-but-missing modules
  const existingPaths = new Set(modules.map(m => m.path));
  for (const imp of analysis.imports) {
    if (!imp.isRelative) continue;

    // Try to resolve the import
    const importDir = resolveRelativeImport(imp.file, imp.source);
    if (importDir && !existingPaths.has(importDir)) {
      // Check if the resolved file/dir actually exists in our file tree
      const resolvedExists = flatFiles.some(f => f.path.startsWith(importDir));
      if (!resolvedExists) {
        modules.push({
          id: `mod_missing_${importDir.replace(/[^a-zA-Z0-9]/g, '_')}`,
          name: importDir.split('/').pop() || importDir,
          type: inferModuleType(importDir, []),
          path: importDir,
          files: [],
          status: 'missing',
          evidence: [{
            file: imp.file,
            line: imp.line,
            reason: `Imported but file/module not found: ${imp.source}`,
          }],
        });
        existingPaths.add(importDir);
      }
    }
  }

  return modules;
}

// ─── Dependency Extraction ───────────────────────────────────────────────────

export function extractDependencies(modules: Module[], analysis: AnalyzerResult): Dependency[] {
  const dependencies: Dependency[] = [];
  const moduleByFile: Record<string, string> = {};

  // Map files to module IDs
  for (const mod of modules) {
    for (const file of mod.files) {
      moduleByFile[file] = mod.id;
    }
  }

  // Find dependencies from imports
  for (const imp of analysis.imports) {
    if (!imp.isRelative) continue;

    const sourceModuleId = moduleByFile[imp.file];
    if (!sourceModuleId) continue;

    // Try to resolve target module
    const importDir = resolveRelativeImport(imp.file, imp.source);
    if (!importDir) continue;

    const targetModule = modules.find(m =>
      m.path === importDir ||
      m.files.some(f => f.startsWith(importDir))
    );

    if (targetModule && targetModule.id !== sourceModuleId) {
      // Avoid duplicate dependencies
      const exists = dependencies.some(d =>
        d.from === sourceModuleId && d.to === targetModule.id && d.type === 'imports'
      );
      if (!exists) {
        dependencies.push({
          id: `dep_${sourceModuleId}_${targetModule.id}`,
          from: sourceModuleId,
          to: targetModule.id,
          type: 'imports',
          evidence: [{
            file: imp.file,
            line: imp.line,
            reason: `Imports from ${imp.source}`,
          }],
        });
      }
    }
  }

  // Find test dependencies
  for (const test of analysis.tests) {
    const testModuleId = moduleByFile[test.file];
    if (!testModuleId) continue;

    // Infer what the test is testing based on filename
    const testSubject = test.file
      .replace(/\.test\.|\.spec\./, '.')
      .replace(/^test_/, '')
      .replace(/_test\./, '.')
      .replace(/__tests__\//, '');

    const targetModule = modules.find(m =>
      m.files.some(f => f === testSubject || f.endsWith(testSubject))
    );

    if (targetModule && targetModule.id !== testModuleId) {
      dependencies.push({
        id: `dep_test_${testModuleId}_${targetModule.id}`,
        from: testModuleId,
        to: targetModule.id,
        type: 'tests',
        evidence: [{
          file: test.file,
          reason: `Tests ${targetModule.name}`,
        }],
      });
    }
  }

  // Find route → handler dependencies
  for (const route of analysis.routes) {
    const routeModuleId = moduleByFile[route.file];
    if (!routeModuleId) continue;

    // Check if the route handler references other modules
    const routeModule = modules.find(m => m.id === routeModuleId);
    if (routeModule) {
      // Routes typically depend on models/services
      for (const mod of modules) {
        if (mod.type === 'model' || mod.type === 'service') {
          const routeImports = analysis.imports.filter(i => i.file === route.file);
          const dependsOnModule = routeImports.some(i => {
            const resolvedDir = resolveRelativeImport(i.file, i.source);
            return resolvedDir && (resolvedDir === mod.path || mod.files.some(f => f.startsWith(resolvedDir)));
          });

          if (dependsOnModule) {
            const exists = dependencies.some(d => d.from === routeModuleId && d.to === mod.id);
            if (!exists) {
              dependencies.push({
                id: `dep_route_${routeModuleId}_${mod.id}`,
                from: routeModuleId,
                to: mod.id,
                type: 'requires',
                evidence: [{
                  file: route.file,
                  line: route.line,
                  reason: `Route ${route.method} ${route.path} depends on ${mod.name}`,
                }],
              });
            }
          }
        }
      }
    }
  }

  return dependencies;
}

// ─── Build Dependency Graph ──────────────────────────────────────────────────

export function buildDependencyGraph(modules: Module[], dependencies: Dependency[]): DependencyGraph {
  const nodes: DependencyNode[] = modules.map(mod => ({
    id: mod.id,
    label: mod.name,
    type: mod.type,
    status: mod.status,
    layer: LAYER_ORDER[mod.type] ?? 3,
    files: mod.files,
  }));

  const edges: DependencyEdge[] = dependencies.map(dep => ({
    source: dep.from,
    target: dep.to,
    type: dep.type,
  }));

  // Adjust layers based on actual dependencies
  const graph = { nodes, edges };
  computeLayers(graph);

  return graph;
}

// ─── Compute Topological Layers ──────────────────────────────────────────────

function computeLayers(graph: DependencyGraph): void {
  const adj: Record<string, string[]> = {};
  const inDegree: Record<string, number> = {};

  for (const node of graph.nodes) {
    adj[node.id] = [];
    inDegree[node.id] = 0;
  }

  for (const edge of graph.edges) {
    if (adj[edge.source]) {
      adj[edge.source].push(edge.target);
    }
    if (inDegree[edge.target] !== undefined) {
      inDegree[edge.target]++;
    }
  }

  // Topological sort (Kahn's algorithm)
  const queue: string[] = Object.entries(inDegree)
    .filter(([_, deg]) => deg === 0)
    .map(([id]) => id);

  const layerMap: Record<string, number> = {};
  for (const id of queue) layerMap[id] = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of adj[current] || []) {
      layerMap[neighbor] = Math.max(layerMap[neighbor] || 0, (layerMap[current] || 0) + 1);
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) {
        queue.push(neighbor);
      }
    }
  }

  for (const node of graph.nodes) {
    if (layerMap[node.id] !== undefined) {
      node.layer = layerMap[node.id];
    }
  }
}

// ─── Find Blocked Work ──────────────────────────────────────────────────────

export function findBlockedWork(modules: Module[], dependencies: Dependency[]): BlockedWork[] {
  const blocked: BlockedWork[] = [];
  const moduleMap = new Map(modules.map(m => [m.id, m]));

  for (const mod of modules) {
    if (mod.status === 'complete') continue;

    // Find all modules this module depends on
    const depsForModule = dependencies.filter(d => d.from === mod.id);
    const missingPrereqs: string[] = [];

    for (const dep of depsForModule) {
      const target = moduleMap.get(dep.to);
      if (target && (target.status === 'missing' || target.status === 'skeleton')) {
        missingPrereqs.push(target.id);
      }
    }

    if (missingPrereqs.length > 0) {
      const blockerNames = missingPrereqs
        .map(id => moduleMap.get(id)?.name || id)
        .join(', ');

      blocked.push({
        moduleId: mod.id,
        name: mod.name,
        blockedBy: missingPrereqs,
        reason: `Depends on incomplete modules: ${blockerNames}`,
      });
    }
  }

  return blocked;
}

// ─── Find Completed Work ────────────────────────────────────────────────────

export function findCompletedWork(modules: Module[]): CompletedWork[] {
  return modules
    .filter(m => m.status === 'complete')
    .map(m => ({
      moduleId: m.id,
      name: m.name,
      evidence: m.evidence,
    }));
}

// ─── Find Missing Work ──────────────────────────────────────────────────────

export function findMissingWork(modules: Module[], dependencies: Dependency[]): MissingWork[] {
  return modules
    .filter(m => m.status === 'missing')
    .map(m => {
      // Find who references this missing module
      const referencedBy = dependencies
        .filter(d => d.to === m.id)
        .map(d => d.from);

      return {
        name: m.name,
        description: `Module ${m.name} is referenced but does not exist`,
        expectedType: m.type,
        referencedBy,
        evidence: m.evidence,
      };
    });
}

// ─── Detect Scope Risks ─────────────────────────────────────────────────────

export function detectScopeRisks(
  modules: Module[],
  dependencies: Dependency[],
  blockedWork: BlockedWork[],
  projectGoal?: string
): ScopeRisk[] {
  const risks: ScopeRisk[] = [];

  // Detect downstream work (working on things whose prereqs aren't done)
  for (const bw of blockedWork) {
    const mod = modules.find(m => m.id === bw.moduleId);
    if (mod && mod.status === 'partial') {
      risks.push({
        type: 'downstream_work',
        severity: 'high',
        description: `Module "${mod.name}" is being worked on, but its prerequisites are incomplete`,
        affectedModules: [mod.id, ...bw.blockedBy],
        recommendation: `Finish ${bw.blockedBy.map(id => modules.find(m => m.id === id)?.name || id).join(', ')} first`,
      });
    }
  }

  // Detect scope expansion (too many unconnected modules)
  const totalModules = modules.length;
  const connectedModules = new Set<string>();
  for (const dep of dependencies) {
    connectedModules.add(dep.from);
    connectedModules.add(dep.to);
  }
  const disconnectedModules = modules.filter(m => !connectedModules.has(m.id) && m.type !== 'config');
  if (disconnectedModules.length > totalModules * 0.3 && totalModules > 5) {
    risks.push({
      type: 'scope_expansion',
      severity: 'medium',
      description: `${disconnectedModules.length} modules appear disconnected from the main project graph`,
      affectedModules: disconnectedModules.map(m => m.id),
      recommendation: 'Focus on completing the core feature graph before adding new standalone modules',
    });
  }

  // Detect missing prerequisites
  const missingModules = modules.filter(m => m.status === 'missing');
  if (missingModules.length > 0) {
    for (const mm of missingModules) {
      const dependents = dependencies
        .filter(d => d.to === mm.id)
        .map(d => modules.find(m => m.id === d.from)?.name || d.from);

      if (dependents.length > 0) {
        risks.push({
          type: 'missing_prerequisite',
          severity: 'high',
          description: `"${mm.name}" is missing but required by: ${dependents.join(', ')}`,
          affectedModules: [mm.id],
          recommendation: `Create ${mm.name} to unblock dependent modules`,
        });
      }
    }
  }

  return risks;
}

// ─── Build Full Project State ────────────────────────────────────────────────

export function buildProjectState(
  analysis: AnalyzerResult,
  projectName: string,
  projectGoal: string
): { state: ProjectState; graph: DependencyGraph } {
  const modules = detectModules(analysis);
  const dependencies = extractDependencies(modules, analysis);
  const graph = buildDependencyGraph(modules, dependencies);

  const completedWork = findCompletedWork(modules);
  const missingWork = findMissingWork(modules, dependencies);
  const blockedWork = findBlockedWork(modules, dependencies);
  const scopeRisks = detectScopeRisks(modules, dependencies, blockedWork, projectGoal);

  // Detect frameworks from packages
  const frameworks: string[] = [];
  for (const pkg of analysis.packageFiles) {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps['react']) frameworks.push('React');
    if (allDeps['next']) frameworks.push('Next.js');
    if (allDeps['express']) frameworks.push('Express');
    if (allDeps['vue']) frameworks.push('Vue');
    if (allDeps['@angular/core']) frameworks.push('Angular');
    if (allDeps['flask'] || allDeps['Flask']) frameworks.push('Flask');
    if (allDeps['django'] || allDeps['Django']) frameworks.push('Django');
    if (allDeps['fastapi'] || allDeps['FastAPI']) frameworks.push('FastAPI');
  }

  // Build features from modules (simple grouping)
  const features = buildFeatures(modules, dependencies);

  const state: ProjectState = {
    project: {
      name: projectName,
      goal: projectGoal,
      languages: analysis.languages.map(l => l.language),
      frameworks: [...new Set(frameworks)],
    },
    features,
    modules,
    dependencies,
    completedWork,
    missingWork,
    blockedWork,
    scopeRisks,
    recentChanges: [],
  };

  return { state, graph };
}

// ─── Build Features ─────────────────────────────────────────────────────────

function buildFeatures(modules: Module[], dependencies: Dependency[]): Feature[] {
  // Group modules into features based on naming/path conventions
  const featureGroups: Record<string, Module[]> = {};

  for (const mod of modules) {
    // Use top-level directory as feature group
    const parts = mod.path.split('/');
    let featureName = parts.length > 1 ? parts[0] : 'core';

    // Special cases
    if (mod.path.includes('test') || mod.type === 'test') featureName = 'testing';
    if (mod.type === 'config') featureName = 'configuration';

    if (!featureGroups[featureName]) featureGroups[featureName] = [];
    featureGroups[featureName].push(mod);
  }

  return Object.entries(featureGroups).map(([name, mods]) => {
    const completed = mods.filter(m => m.status === 'complete').length;
    const total = mods.length;
    const completionPercentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    let status: Feature['status'] = 'not_started';
    if (completionPercentage === 100) status = 'completed';
    else if (completionPercentage > 0) status = 'in_progress';
    else if (mods.some(m => m.status === 'missing')) status = 'blocked';

    return {
      id: `feat_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
      name,
      description: `Feature group: ${name}`,
      status,
      modules: mods.map(m => m.id),
      completionPercentage,
    };
  });
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function flattenTree(nodes: { path: string; type: string; children?: any[] }[]): any[] {
  const flat: any[] = [];
  function walk(nodeList: any[]) {
    for (const node of nodeList) {
      flat.push(node);
      if (node.children) walk(node.children);
    }
  }
  walk(nodes);
  return flat;
}

function inferModuleType(dirPath: string, files: string[]): ModuleType {
  const lower = dirPath.toLowerCase();

  if (lower.includes('model') || lower.includes('schema')) return 'model';
  if (lower.includes('route') || lower.includes('api')) return 'route';
  if (lower.includes('controller')) return 'controller';
  if (lower.includes('service')) return 'service';
  if (lower.includes('middleware')) return 'middleware';
  if (lower.includes('component') || lower.includes('ui') || lower.includes('views') || lower.includes('pages')) return 'component';
  if (lower.includes('test') || lower.includes('spec') || lower.includes('__tests__')) return 'test';
  if (lower.includes('config') || lower.includes('settings')) return 'config';
  if (lower.includes('migration') || lower.includes('migrate')) return 'migration';
  if (lower.includes('util') || lower.includes('helper') || lower.includes('lib') || lower.includes('utils')) return 'utility';

  // Check file contents for hints
  for (const file of files) {
    if (file.endsWith('.test.ts') || file.endsWith('.spec.ts') || file.endsWith('.test.js') || file.endsWith('.spec.js')) return 'test';
    if (/test_.*\.py$/.test(file) || /.*_test\.py$/.test(file)) return 'test';
  }

  return 'unknown';
}

function inferModuleStatus(files: string[], analysis: AnalyzerResult): ModuleStatus {
  if (files.length === 0) return 'missing';

  // Check for TODO/FIXME in module files
  const todosInModule = analysis.todoComments.filter(t => files.includes(t.file));
  const hasTodos = todosInModule.length > 0;

  // Check for tests
  const testsInModule = analysis.tests.filter(t => files.includes(t.file));
  const hasFailingTests = testsInModule.some(t => t.status === 'failing');
  const hasSkeletonTests = testsInModule.some(t => t.status === 'skeleton');

  // Check file sizes (very small files might be skeletons)
  // Heuristic: if any source file has content, it's at least partial
  if (hasFailingTests) return 'broken';
  if (hasTodos || hasSkeletonTests) return 'partial';
  if (files.length > 0) return 'complete'; // Optimistic default

  return 'skeleton';
}

function gatherModuleEvidence(dir: string, files: string[], analysis: AnalyzerResult): Evidence[] {
  const evidence: Evidence[] = [];

  // TODOs in this module
  for (const todo of analysis.todoComments) {
    if (files.includes(todo.file)) {
      evidence.push({
        file: todo.file,
        line: todo.line,
        reason: `${todo.type}: ${todo.text}`,
      });
    }
  }

  // Routes in this module
  for (const route of analysis.routes) {
    if (files.includes(route.file)) {
      evidence.push({
        file: route.file,
        line: route.line,
        reason: `Route: ${route.method} ${route.path}`,
      });
    }
  }

  // Tests in this module
  for (const test of analysis.tests) {
    if (files.includes(test.file)) {
      evidence.push({
        file: test.file,
        reason: `Tests: ${test.testCases.length} test cases (${test.status})`,
      });
    }
  }

  return evidence;
}

function isSourceFile(filePath: string): boolean {
  const sourceExts = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.java', '.rs', '.go', '.rb', '.php',
    '.cs', '.cpp', '.cc', '.c', '.h', '.hpp',
    '.swift', '.kt', '.dart', '.vue', '.svelte',
  ]);
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  return sourceExts.has(ext);
}

function resolveRelativeImport(fromFile: string, importSource: string): string {
  // Get directory of the importing file
  const fromDir = fromFile.includes('/') ? fromFile.substring(0, fromFile.lastIndexOf('/')) : '.';

  // Resolve the relative path
  const parts = fromDir.split('/');
  const importParts = importSource.split('/');

  for (const part of importParts) {
    if (part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }

  return parts.join('/');
}
