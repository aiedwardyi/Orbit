import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const recorded = "test/fixtures/recorded/";
const testFile = /\.test\.(?:ts|mjs)$|\.node-test\.mjs$/;

function referencedFiles(file, source) {
  const imports = [];
  const fixtures = [];
  const relative = (name) => path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
  const addFixture = (name) => {
    name = path.posix.normalize(name);
    if (name.startsWith(recorded) && name.endsWith(".json")) fixtures.push(name);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      const name = node.moduleSpecifier.text;
      if (name.startsWith(".")) {
        imports.push(relative(name));
        addFixture(relative(name));
      }
    }
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText();
      const argument = node.arguments[0];
      if (["readFile", "readFileSync", "require", "import"].includes(name) && argument) {
        if (ts.isStringLiteral(argument)) addFixture(name === "readFile" || name === "readFileSync" ? argument.text : relative(argument.text));
        if (ts.isNewExpression(argument) && argument.expression.getText() === "URL" && argument.arguments?.length === 2 &&
            ts.isStringLiteral(argument.arguments[0]) && argument.arguments[1].getText() === "import.meta.url") {
          addFixture(relative(argument.arguments[0].text));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  return { imports, fixtures };
}

export function missingRealFixture(seams, changed, read) {
  const parsed = new Map();
  for (const seam of seams) {
    if (!changed.includes(seam.path)) continue;
    const tests = new Set([...seam.tests, ...changed.filter((file) => testFile.test(file))]);
    const covered = [...tests].some((file) => {
      if (!testFile.test(file)) return false;
      if (!parsed.has(file)) {
        const source = read(file);
        parsed.set(file, source === null ? null : referencedFiles(file, source));
      }
      const references = parsed.get(file);
      return references?.imports.includes(seam.path) && references.fixtures.some((fixture) => {
        const source = read(fixture);
        if (source === null) return false;
        try {
          const { stamp, reply } = JSON.parse(source);
          return typeof reply === "object" && reply !== null && typeof stamp?.engine === "string" && typeof stamp.cliVersion === "string" &&
            Number.isFinite(Date.parse(stamp.recordedAt)) && ["home", "work"].includes(stamp.sourcePc);
        } catch {
          return false;
        }
      });
    });
    if (!covered) return `${seam.path}: missing ${recorded}<engine>/<name>.json loaded by a seam test`;
  }
  return null;
}

function main() {
  const [base, head] = process.argv.slice(2);
  if (!base) throw new Error("usage: node scripts/check-real-fixtures.mjs <base> [head]");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const seams = JSON.parse(readFileSync(new URL("./engine-seams.json", import.meta.url), "utf8"));
  const changed = git(["diff", "--name-only", "--no-renames", base, ...(head ? [head] : []), "--"]).trim().split(/\r?\n/).filter(Boolean);
  const read = (file) => {
    try {
      return head ? git(["show", `${head}:${file}`]) : readFileSync(path.join(root, file), "utf8");
    } catch {
      return null;
    }
  };
  const missing = missingRealFixture(seams, changed, read);
  if (missing) {
    console.error(missing);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(String(error.message).split(/\r?\n/, 1)[0]);
    process.exitCode = 1;
  }
}
