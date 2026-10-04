import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  FileNode,
  LanguageInfo,
  PackageInfo,
  ReadmeInfo,
  TodoComment,
  RouteInfo,
  ImportInfo,
  ClassInfo,
  FunctionInfo,
  TestInfo,
  ConfigInfo,
  EnvInfo,
  AnalyzerResult,
} from '@breadcrumb/shared';

// ─── Language Extensions Map ─────────────────────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.pyw': 'Python',
  '.java': 'Java',
  '.rs': 'Rust',
  '.go': 'Go',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.h': 'C/C++', '.hpp': 'C++',
  '.c': 'C',
  '.swift': 'Swift',
  '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.dart': 'Dart',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.html': 'HTML', '.htm': 'HTML',
  '.css': 'CSS', '.scss': 'SCSS', '.sass': 'SASS', '.less': 'LESS',
  '.sql': 'SQL',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell',
};

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.next', '.nuxt', 'target', 'out',
  '.idea', '.vscode', '.vs', 'coverage', '.turbo',
  'vendor', 'bower_components', '.cache', '.parcel-cache',
]);

const IGNORED_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.gitkeep',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'Cargo.lock', 'poetry.lock', 'Pipfile.lock',
]);

const MAX_FILE_SIZE = 512 * 1024; // 512KB max per file

// ─── File Tree Scanner ───────────────────────────────────────────────────────

export function scanFileTree(rootPath: string, maxDepth = 10): FileNode[] {
  const results: FileNode[] = [];

  function walk(dirPath: string, depth: number): FileNode[] {
    if (depth > maxDepth) return [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }

    const nodes: FileNode[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example' && entry.name !== '.env') {
        // Allow .env.example but skip most dotfiles/dotdirs
        if (IGNORED_DIRS.has(entry.name) || entry.isDirectory()) continue;
      }

      if (IGNORED_DIRS.has(entry.name)) continue;
      if (IGNORED_FILES.has(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(rootPath, fullPath);

      if (entry.isDirectory()) {
        const children = walk(fullPath, depth + 1);
        nodes.push({
          path: relativePath,
          name: entry.name,
          type: 'directory',
          children,
        });
      } else if (entry.isFile()) {
        let size: number | undefined;
        try {
          const stat = fs.statSync(fullPath);
          size = stat.size;
        } catch {
          // skip
        }

        nodes.push({
          path: relativePath,
          name: entry.name,
          type: 'file',
          extension: path.extname(entry.name).toLowerCase(),
          size,
        });
      }
    }

    return nodes;
  }

  return walk(rootPath, 0);
}

// ─── Flatten File Tree ───────────────────────────────────────────────────────

export function flattenFileTree(nodes: FileNode[]): FileNode[] {
  const flat: FileNode[] = [];

  function walk(nodeList: FileNode[]) {
    for (const node of nodeList) {
      flat.push(node);
      if (node.children) walk(node.children);
    }
  }

  walk(nodes);
  return flat;
}

// ─── Language Detection ──────────────────────────────────────────────────────

export function detectLanguages(rootPath: string, files: FileNode[]): LanguageInfo[] {
  const langStats: Record<string, { extensions: Set<string>; fileCount: number; lineCount: number }> = {};

  const sourceFiles = files.filter(f => f.type === 'file' && f.extension && LANGUAGE_MAP[f.extension]);

  for (const file of sourceFiles) {
    const lang = LANGUAGE_MAP[file.extension!];
    if (!lang) continue;

    if (!langStats[lang]) {
      langStats[lang] = { extensions: new Set(), fileCount: 0, lineCount: 0 };
    }

    langStats[lang].extensions.add(file.extension!);
    langStats[lang].fileCount++;

    try {
      const fullPath = path.join(rootPath, file.path);
      const stat = fs.statSync(fullPath);
      if (stat.size <= MAX_FILE_SIZE) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        langStats[lang].lineCount += content.split('\n').length;
      }
    } catch {
      // skip unreadable files
    }
  }

  const totalLines = Object.values(langStats).reduce((sum, s) => sum + s.lineCount, 0);

  return Object.entries(langStats)
    .map(([language, stats]) => ({
      language,
      extensions: Array.from(stats.extensions),
      fileCount: stats.fileCount,
      lineCount: stats.lineCount,
      percentage: totalLines > 0 ? Math.round((stats.lineCount / totalLines) * 100) : 0,
    }))
    .sort((a, b) => b.lineCount - a.lineCount);
}

// ─── Read File Safely ────────────────────────────────────────────────────────

function readFileSafe(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Package File Parser ─────────────────────────────────────────────────────

export function parsePackageFiles(rootPath: string, files: FileNode[]): PackageInfo[] {
  const results: PackageInfo[] = [];

  for (const file of files) {
    if (file.type !== 'file') continue;
    const fullPath = path.join(rootPath, file.path);

    if (file.name === 'package.json') {
      const content = readFileSafe(fullPath);
      if (!content) continue;
      try {
        const pkg = JSON.parse(content);
        results.push({
          file: file.path,
          type: 'npm',
          name: pkg.name,
          dependencies: pkg.dependencies || {},
          devDependencies: pkg.devDependencies || {},
          scripts: pkg.scripts || {},
        });
      } catch { /* skip invalid JSON */ }
    }

    if (file.name === 'requirements.txt') {
      const content = readFileSafe(fullPath);
      if (!content) continue;
      const deps: Record<string, string> = {};
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([a-zA-Z0-9_-]+)([><=!~]+.+)?$/);
        if (match) {
          deps[match[1]] = match[2] || '*';
        }
      }
      results.push({
        file: file.path,
        type: 'pip',
        dependencies: deps,
        devDependencies: {},
      });
    }

    if (file.name === 'Cargo.toml') {
      results.push({
        file: file.path,
        type: 'cargo',
        dependencies: {},
        devDependencies: {},
      });
    }

    if (file.name === 'go.mod') {
      results.push({
        file: file.path,
        type: 'go',
        dependencies: {},
        devDependencies: {},
      });
    }
  }

  return results;
}

// ─── README Parser ───────────────────────────────────────────────────────────

export function parseReadme(rootPath: string, files: FileNode[]): ReadmeInfo | null {
  const readmeFile = files.find(f =>
    f.type === 'file' && /^readme\.(md|txt|rst)$/i.test(f.name)
  );

  if (!readmeFile) return null;

  const content = readFileSafe(path.join(rootPath, readmeFile.path));
  if (!content) return null;

  const lines = content.split('\n');
  const title = lines.find(l => l.startsWith('# '))?.replace(/^#\s+/, '').trim();

  // Extract sections (## headings)
  const sections = lines
    .filter(l => l.startsWith('## '))
    .map(l => l.replace(/^##\s+/, '').trim());

  // Extract description (first paragraph after title)
  let description: string | undefined;
  let foundTitle = false;
  const descLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('# ')) { foundTitle = true; continue; }
    if (foundTitle && line.trim() === '' && descLines.length > 0) break;
    if (foundTitle && line.trim()) descLines.push(line.trim());
  }
  if (descLines.length > 0) description = descLines.join(' ');

  // Detect mentioned technologies
  const techPatterns = [
    'React', 'Vue', 'Angular', 'Next.js', 'Express', 'Flask', 'Django',
    'FastAPI', 'Node.js', 'Python', 'TypeScript', 'JavaScript', 'Rust',
    'Go', 'Docker', 'PostgreSQL', 'MongoDB', 'Redis', 'GraphQL',
    'REST', 'API', 'JWT', 'OAuth', 'WebSocket', 'TensorFlow', 'PyTorch',
  ];

  const lowerContent = content.toLowerCase();
  const mentionedTechnologies = techPatterns.filter(t =>
    lowerContent.includes(t.toLowerCase())
  );

  return {
    file: readmeFile.path,
    title,
    description,
    sections,
    mentionedTechnologies,
    rawContent: content.slice(0, 5000), // Cap raw content
  };
}

// ─── TODO/FIXME Scanner ──────────────────────────────────────────────────────

export function scanTodos(rootPath: string, files: FileNode[]): TodoComment[] {
  const todos: TodoComment[] = [];
  const pattern = /\b(TODO|FIXME|HACK|XXX|BUG)\b[:\s]*(.*)/i;

  const sourceExts = new Set(Object.keys(LANGUAGE_MAP));

  for (const file of files) {
    if (file.type !== 'file') continue;
    if (!file.extension || !sourceExts.has(file.extension)) continue;

    const content = readFileSafe(path.join(rootPath, file.path));
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(pattern);
      if (match) {
        todos.push({
          file: file.path,
          line: i + 1,
          type: match[1].toUpperCase() as TodoComment['type'],
          text: match[2]?.trim() || '',
        });
      }
    }
  }

  return todos;
}

// ─── Route Extractor ─────────────────────────────────────────────────────────

export function extractRoutes(rootPath: string, files: FileNode[]): RouteInfo[] {
  const routes: RouteInfo[] = [];

  // Express/Node patterns
  const expressPattern = /\b(?:app|router|server)\.(get|post|put|patch|delete|use|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

  // Flask/FastAPI patterns
  const pythonRoutePattern = /@(?:app|router|api)\.(?:route|get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi;

  // Next.js API routes are inferred from file paths
  const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py']);

  for (const file of files) {
    if (file.type !== 'file') continue;
    if (!file.extension || !sourceExts.has(file.extension)) continue;

    const content = readFileSafe(path.join(rootPath, file.path));
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Express-style routes
      let match;
      const expressRe = /\b(?:app|router|server)\.(get|post|put|patch|delete|use|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
      while ((match = expressRe.exec(line)) !== null) {
        routes.push({
          file: file.path,
          method: match[1].toUpperCase(),
          path: match[2],
          line: i + 1,
        });
      }

      // Python-style routes
      const pyRe = /@(?:app|router|api)\.(?:route|get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi;
      while ((match = pyRe.exec(line)) !== null) {
        const method = line.includes('.get') ? 'GET'
          : line.includes('.post') ? 'POST'
          : line.includes('.put') ? 'PUT'
          : line.includes('.patch') ? 'PATCH'
          : line.includes('.delete') ? 'DELETE'
          : 'ANY';
        routes.push({
          file: file.path,
          method,
          path: match[1],
          line: i + 1,
        });
      }
    }

    // Next.js API routes
    if (file.path.includes('api/') && (file.path.includes('pages/') || file.path.includes('app/'))) {
      const routePath = '/' + file.path
        .replace(/^.*?(pages|app)\//, '')
        .replace(/\/route\.(ts|js)$/, '')
        .replace(/\.(ts|tsx|js|jsx)$/, '')
        .replace(/\/index$/, '')
        .replace(/\[([^\]]+)\]/g, ':$1');
      routes.push({
        file: file.path,
        method: 'ANY',
        path: routePath,
        line: 1,
      });
    }
  }

  return routes;
}

// ─── Import Extractor ────────────────────────────────────────────────────────

export function extractImports(rootPath: string, files: FileNode[]): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

  for (const file of files) {
    if (file.type !== 'file') continue;
    if (!file.extension || !sourceExts.has(file.extension)) continue;

    const content = readFileSafe(path.join(rootPath, file.path));
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // ES import
      const esMatch = line.match(/import\s+(?:(?:{([^}]+)}|(\w+))\s+from\s+)?['"]([^'"]+)['"]/);
      if (esMatch) {
        const specifiers: string[] = [];
        if (esMatch[1]) {
          specifiers.push(...esMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
        }
        if (esMatch[2]) specifiers.push(esMatch[2]);

        imports.push({
          file: file.path,
          line: i + 1,
          source: esMatch[3],
          specifiers,
          isRelative: esMatch[3].startsWith('.') || esMatch[3].startsWith('/'),
        });
      }

      // require
      const reqMatch = line.match(/(?:const|let|var)\s+(?:{([^}]+)}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (reqMatch) {
        const specifiers: string[] = [];
        if (reqMatch[1]) specifiers.push(...reqMatch[1].split(',').map(s => s.trim()).filter(Boolean));
        if (reqMatch[2]) specifiers.push(reqMatch[2]);

        imports.push({
          file: file.path,
          line: i + 1,
          source: reqMatch[3],
          specifiers,
          isRelative: reqMatch[3].startsWith('.') || reqMatch[3].startsWith('/'),
        });
      }
    }

    // Python imports
    if (file.extension === '.py') {
      const pyContent = readFileSafe(path.join(rootPath, file.path));
      if (!pyContent) continue;

      const pyLines = pyContent.split('\n');
      for (let i = 0; i < pyLines.length; i++) {
        const line = pyLines[i];

        const fromMatch = line.match(/from\s+(\S+)\s+import\s+(.+)/);
        if (fromMatch) {
          imports.push({
            file: file.path,
            line: i + 1,
            source: fromMatch[1],
            specifiers: fromMatch[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean),
            isRelative: fromMatch[1].startsWith('.'),
          });
        }

        const importMatch = line.match(/^import\s+(\S+)/);
        if (importMatch && !line.includes('from')) {
          imports.push({
            file: file.path,
            line: i + 1,
            source: importMatch[1],
            specifiers: [importMatch[1].split('.').pop() || importMatch[1]],
            isRelative: importMatch[1].startsWith('.'),
          });
        }
      }
    }
  }

  return imports;
}

// ─── Class Extractor ─────────────────────────────────────────────────────────

export function extractClasses(rootPath: string, files: FileNode[]): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cs']);

  for (const file of files) {
    if (file.type !== 'file') continue;
    if (!file.extension || !sourceExts.has(file.extension)) continue;

    const content = readFileSafe(path.join(rootPath, file.path));
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // JS/TS class
      const jsMatch = line.match(/(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+(.+?))?[\s{]/);
      if (jsMatch) {
        // Extract method names from subsequent lines
        const methods: string[] = [];
        for (let j = i + 1; j < Math.min(i + 200, lines.length); j++) {
          const methodMatch = lines[j].match(/^\s+(?:async\s+)?(?:static\s+)?(\w+)\s*\(/);
          if (methodMatch && methodMatch[1] !== 'constructor') {
            methods.push(methodMatch[1]);
          }
          if (lines[j].match(/^}/)) break;
        }

        classes.push({
          file: file.path,
          name: jsMatch[1],
          line: i + 1,
          methods,
          extends: jsMatch[2],
          implements: jsMatch[3]?.split(',').map(s => s.trim()),
        });
      }

      // Python class
      const pyMatch = line.match(/^class\s+(\w+)(?:\(([^)]*)\))?:/);
      if (pyMatch) {
        const methods: string[] = [];
        for (let j = i + 1; j < Math.min(i + 200, lines.length); j++) {
          const methodMatch = lines[j].match(/^\s+(?:async\s+)?def\s+(\w+)\s*\(/);
          if (methodMatch) methods.push(methodMatch[1]);
          if (lines[j].match(/^class\s/) || (lines[j].match(/^\S/) && j > i + 1)) break;
        }

        classes.push({
          file: file.path,
          name: pyMatch[1],
          line: i + 1,
          methods,
          extends: pyMatch[2]?.split(',')[0]?.trim(),
        });
      }
    }
  }

  return classes;
}

// ─── Function Extractor ──────────────────────────────────────────────────────

export function extractFunctions(rootPath: string, files: FileNode[]): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py']);

  for (const file of files) {
    if (file.type !== 'file') continue;
    if (!file.extension || !sourceExts.has(file.extension)) continue;

    const content = readFileSafe(path.join(rootPath, file.path));
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // JS/TS function declaration
      const funcMatch = line.match(/(?:(export)\s+)?(?:(async)\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
      if (funcMatch) {
        functions.push({
          file: file.path,
          name: funcMatch[3],
          line: i + 1,
          params: funcMatch[4] ? funcMatch[4].split(',').map(p => p.trim().split(/[:\s=]/)[0].trim()).filter(Boolean) : [],
          isExported: !!funcMatch[1],
          isAsync: !!funcMatch[2],
        });
      }

      // Arrow function export
      const arrowMatch = line.match(/(?:(export)\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:(async)\s+)?\(?([^)=>]*)\)?\s*=>/);
      if (arrowMatch) {
        functions.push({
          file: file.path,
          name: arrowMatch[2],
          line: i + 1,
          params: arrowMatch[4] ? arrowMatch[4].split(',').map(p => p.trim().split(/[:\s=]/)[0].trim()).filter(Boolean) : [],
          isExported: !!arrowMatch[1],
          isAsync: !!arrowMatch[3],
        });
      }

      // Python function
      if (file.extension === '.py') {
        const pyFuncMatch = line.match(/^(?:(async)\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
        if (pyFuncMatch) {
          functions.push({
            file: file.path,
            name: pyFuncMatch[2],
            line: i + 1,
            params: pyFuncMatch[3] ? pyFuncMatch[3].split(',').map(p => p.trim().split(/[:\s=]/)[0].trim()).filter(p => p && p !== 'self' && p !== 'cls') : [],
            isExported: !pyFuncMatch[2].startsWith('_'),
            isAsync: !!pyFuncMatch[1],
          });
        }
      }
    }
  }

  return functions;
}

// ─── Test Discoverer ─────────────────────────────────────────────────────────

export function discoverTests(rootPath: string, files: FileNode[]): TestInfo[] {
  const tests: TestInfo[] = [];

  for (const file of files) {
    if (file.type !== 'file') continue;

    const isTest = /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file.name) ||
                   /^test_.*\.py$/.test(file.name) ||
                   /^.*_test\.py$/.test(file.name) ||
                   /^.*_test\.go$/.test(file.name) ||
                   file.path.includes('__tests__/') ||
                   file.path.includes('tests/');

    if (!isTest) continue;

    const content = readFileSafe(path.join(rootPath, file.path));
    if (!content) {
      tests.push({ file: file.path, framework: 'unknown', testCases: [], status: 'exists' });
      continue;
    }

    // Detect framework
    let framework: TestInfo['framework'] = 'unknown';
    if (content.includes('vitest') || content.includes("from 'vitest'")) framework = 'vitest';
    else if (content.includes('jest') || content.includes('describe(') && content.includes('it(')) framework = 'jest';
    else if (content.includes('mocha')) framework = 'mocha';
    else if (content.includes('pytest') || content.includes('def test_')) framework = 'pytest';
    else if (content.includes('unittest')) framework = 'unittest';

    // Extract test case names
    const testCases: string[] = [];
    const lines = content.split('\n');
    for (const line of lines) {
      // JS: it('...'), test('...')
      const jsMatch = line.match(/(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/);
      if (jsMatch) testCases.push(jsMatch[1]);

      // Python: def test_...
      const pyMatch = line.match(/def\s+(test_\w+)/);
      if (pyMatch) testCases.push(pyMatch[1]);
    }

    // Detect skeleton (file exists but no real test content)
    const status: TestInfo['status'] = testCases.length === 0 ? 'skeleton' : 'exists';

    tests.push({ file: file.path, framework, testCases, status });
  }

  return tests;
}

// ─── Config File Detector ────────────────────────────────────────────────────

export function detectConfigs(rootPath: string, files: FileNode[]): ConfigInfo[] {
  const configs: ConfigInfo[] = [];

  const configPatterns = [
    /^tsconfig.*\.json$/,
    /^\.eslintrc/,
    /^\.prettierrc/,
    /^webpack\.config/,
    /^vite\.config/,
    /^next\.config/,
    /^docker-compose/,
    /^Dockerfile$/,
    /^\.dockerignore$/,
    /^Makefile$/,
    /^\.babelrc/,
    /^jest\.config/,
    /^vitest\.config/,
    /^tailwind\.config/,
    /^postcss\.config/,
    /^\.github/,
    /^Procfile$/,
    /^render\.yaml$/,
  ];

  for (const file of files) {
    if (file.type !== 'file') continue;

    const isConfig = configPatterns.some(p => p.test(file.name));
    if (!isConfig) continue;

    const content = readFileSafe(path.join(rootPath, file.path));
    const keys: string[] = [];

    if (content && file.name.endsWith('.json')) {
      try {
        const obj = JSON.parse(content);
        keys.push(...Object.keys(obj));
      } catch { /* skip */ }
    }

    configs.push({
      file: file.path,
      type: file.name,
      keys,
    });
  }

  return configs;
}

// ─── Env File Parser ─────────────────────────────────────────────────────────

export function parseEnvExample(rootPath: string, files: FileNode[]): EnvInfo | null {
  const envFile = files.find(f =>
    f.type === 'file' && (f.name === '.env.example' || f.name === '.env.sample' || f.name === '.env.template')
  );

  if (!envFile) return null;

  const content = readFileSafe(path.join(rootPath, envFile.path));
  if (!content) return null;

  const variables: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(\w+)\s*=/);
    if (match) variables.push(match[1]);
  }

  // Check which are missing from actual .env
  const envPath = path.join(rootPath, '.env');
  let missingRequired: string[] = [];
  try {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      const envVars = new Set(
        envContent.split('\n')
          .filter(l => l.trim() && !l.trim().startsWith('#'))
          .map(l => l.split('=')[0].trim())
      );
      missingRequired = variables.filter(v => !envVars.has(v));
    } else {
      missingRequired = [...variables];
    }
  } catch {
    missingRequired = [...variables];
  }

  return { file: envFile.path, variables, missingRequired };
}

// ─── Main Analyzer ──────────────────────────────────────────────────────────

export async function analyzeRepository(rootPath: string): Promise<AnalyzerResult> {
  // Verify directory exists
  if (!fs.existsSync(rootPath)) {
    throw new Error(`Path does not exist: ${rootPath}`);
  }

  const stat = fs.statSync(rootPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${rootPath}`);
  }

  // Step 1: Scan file tree
  const fileTree = scanFileTree(rootPath);
  const flatFiles = flattenFileTree(fileTree);

  // Step 2: Detect languages
  const languages = detectLanguages(rootPath, flatFiles);

  // Step 3: Parse package files
  const packageFiles = parsePackageFiles(rootPath, flatFiles);

  // Step 4: Parse README
  const readme = parseReadme(rootPath, flatFiles);

  // Step 5: Scan TODOs
  const todoComments = scanTodos(rootPath, flatFiles);

  // Step 6: Extract routes
  const routes = extractRoutes(rootPath, flatFiles);

  // Step 7: Extract imports
  const imports = extractImports(rootPath, flatFiles);

  // Step 8: Extract classes
  const classes = extractClasses(rootPath, flatFiles);

  // Step 9: Extract functions
  const functions = extractFunctions(rootPath, flatFiles);

  // Step 10: Discover tests
  const tests = discoverTests(rootPath, flatFiles);

  // Step 11: Detect configs
  const configs = detectConfigs(rootPath, flatFiles);

  // Step 12: Parse env example
  const envExample = parseEnvExample(rootPath, flatFiles);

  // Calculate totals
  const sourceFiles = flatFiles.filter(f => f.type === 'file');
  const totalFiles = sourceFiles.length;
  const totalLines = languages.reduce((sum, l) => sum + l.lineCount, 0);

  return {
    fileTree,
    languages,
    packageFiles,
    readme,
    todoComments,
    routes,
    imports,
    classes,
    functions,
    tests,
    configs,
    envExample,
    totalFiles,
    totalLines,
  };
}
