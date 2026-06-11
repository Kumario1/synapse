import { createHash } from "node:crypto";
import { dirname, posix } from "node:path";
import {
  ArrowFunction,
  FunctionExpression,
  ClassDeclaration,
  EnumDeclaration,
  FunctionDeclaration,
  InterfaceDeclaration,
  MethodDeclaration,
  ModuleKind,
  Node,
  Project,
  ScriptTarget,
  SyntaxKind,
  TypeAliasDeclaration,
  VariableDeclaration,
  type PropertyDeclaration,
  type SourceFile
} from "ts-morph";
import type {
  CodeSymbol,
  Signature,
  SignatureParam,
  SymbolChange,
  SymbolId,
  SymbolKind
} from "@synapse/protocol";

export interface ExtractTypeScriptContractsInput {
  filePath: string;
  source: string;
}

export interface ExtractTypeScriptContractsResult {
  symbols: CodeSymbol[];
}

export interface ExtractTypeScriptDependencyGraphInput {
  files: ExtractTypeScriptContractsInput[];
}

export interface TypeScriptDependencyEdge {
  from: SymbolId;
  to: SymbolId;
  kind: "references";
}

export interface ExtractTypeScriptDependencyGraphResult {
  symbols: CodeSymbol[];
  edges: TypeScriptDependencyEdge[];
}

export function extractTypeScriptContracts(
  input: ExtractTypeScriptContractsInput
): ExtractTypeScriptContractsResult {
  const project = createProject();
  const sourceFile = project.createSourceFile(input.filePath, input.source, { overwrite: true });

  return {
    symbols: extractSymbolsFromSourceFile(sourceFile, input.filePath)
  };
}

export function extractTypeScriptDependencyGraph(
  input: ExtractTypeScriptDependencyGraphInput
): ExtractTypeScriptDependencyGraphResult {
  const project = createProject();
  const fileSymbols = new Map<string, CodeSymbol[]>();
  const fileExports = new Map<string, Map<string, SymbolId>>();
  const symbolById = new Map<string, CodeSymbol>();

  for (const file of input.files) {
    const sourceFile = project.createSourceFile(file.filePath, file.source, { overwrite: true });
    const symbols = extractSymbolsFromSourceFile(sourceFile, file.filePath);
    fileSymbols.set(normalizePath(file.filePath), symbols);
    fileExports.set(normalizePath(file.filePath), exportedNameMap(sourceFile, file.filePath));
    for (const symbol of symbols) {
      symbolById.set(symbol.id.raw, symbol);
    }
  }

  const edges = new Map<string, TypeScriptDependencyEdge>();

  for (const file of input.files) {
    const filePath = normalizePath(file.filePath);
    const sourceFile = project.getSourceFileOrThrow(filePath);
    const imports = importedSymbolMap(sourceFile, filePath, fileSymbols, fileExports);
    const symbols = fileSymbols.get(filePath) ?? [];

    for (const symbol of symbols) {
      const node = nodeForSymbol(sourceFile, symbol);
      if (!node) {
        continue;
      }

      for (const identifier of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
        const imported = imports.get(identifier.getText());
        if (!imported || imported.raw === symbol.id.raw) {
          continue;
        }

        const key = `${symbol.id.raw}->${imported.raw}`;
        edges.set(key, {
          from: symbol.id,
          to: imported,
          kind: "references"
        });
      }
    }
  }

  return {
    symbols: [...symbolById.values()].sort((a, b) => a.id.raw.localeCompare(b.id.raw)),
    edges: [...edges.values()].sort((a, b) =>
      `${a.from.raw}->${a.to.raw}`.localeCompare(`${b.from.raw}->${b.to.raw}`)
    )
  };
}

export function diffTypeScriptContracts(
  before: CodeSymbol[],
  after: CodeSymbol[]
): SymbolChange[] {
  const beforeById = bySymbolId(before);
  const afterById = bySymbolId(after);
  const changes: SymbolChange[] = [];

  for (const [raw, beforeSymbol] of beforeById) {
    const afterSymbol = afterById.get(raw);
    if (!afterSymbol) {
      changes.push({
        symbolId: beforeSymbol.id,
        changeKind: "removed",
        before: beforeSymbol,
        after: null
      });
      continue;
    }

    if (beforeSymbol.visibility !== afterSymbol.visibility) {
      changes.push({
        symbolId: beforeSymbol.id,
        changeKind: "visibility_changed",
        before: beforeSymbol,
        after: afterSymbol
      });
      continue;
    }

    if (beforeSymbol.sigHash !== afterSymbol.sigHash) {
      changes.push({
        symbolId: beforeSymbol.id,
        changeKind: "signature_changed",
        before: beforeSymbol,
        after: afterSymbol
      });
    }
  }

  for (const [raw, afterSymbol] of afterById) {
    if (!beforeById.has(raw)) {
      changes.push({
        symbolId: afterSymbol.id,
        changeKind: "added",
        before: null,
        after: afterSymbol
      });
    }
  }

  return changes.sort((a, b) => a.symbolId.raw.localeCompare(b.symbolId.raw));
}

function createProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      allowJs: true,
      target: ScriptTarget.ES2022,
      module: ModuleKind.ESNext,
      strict: true
    }
  });
}

function extractSymbolsFromSourceFile(sourceFile: SourceFile, filePath: string): CodeSymbol[] {
  const symbols = new Map<string, CodeSymbol>();

  for (const [exportName, declarations] of sourceFile.getExportedDeclarations().entries()) {
    for (const declaration of declarations) {
      for (const symbol of symbolsForDeclaration(sourceFile, filePath, declaration, exportName)) {
        symbols.set(symbol.id.raw, symbol);
      }
    }
  }

  return [...symbols.values()].sort((a, b) => a.id.raw.localeCompare(b.id.raw));
}

/**
 * Exported-name → symbol id for one file. Captures what the *importer* sees —
 * in particular `default`, which can point at a declaration whose own name
 * differs (`export default function Panel`), so default-import edges resolve
 * to the real symbol instead of looking for one literally named "default".
 */
function exportedNameMap(sourceFile: SourceFile, filePath: string): Map<string, SymbolId> {
  const exports = new Map<string, SymbolId>();

  for (const [exportName, declarations] of sourceFile.getExportedDeclarations().entries()) {
    for (const declaration of declarations) {
      const [symbol] = symbolsForDeclaration(sourceFile, filePath, declaration, exportName);
      if (symbol) {
        exports.set(exportName, symbol.id);
        break;
      }
    }
  }

  return exports;
}

function importedSymbolMap(
  sourceFile: SourceFile,
  filePath: string,
  fileSymbols: Map<string, CodeSymbol[]>,
  fileExports: Map<string, Map<string, SymbolId>>
): Map<string, SymbolId> {
  const imports = new Map<string, SymbolId>();

  for (const declaration of sourceFile.getImportDeclarations()) {
    const targetPath = resolveRelativeModule(
      filePath,
      declaration.getModuleSpecifierValue(),
      fileSymbols
    );
    if (!targetPath) {
      continue;
    }

    const targetSymbols = fileSymbols.get(targetPath) ?? [];
    const targetExports = fileExports.get(targetPath) ?? new Map<string, SymbolId>();

    for (const namedImport of declaration.getNamedImports()) {
      const importedName = namedImport.getName();
      const localName = namedImport.getAliasNode()?.getText() ?? importedName;
      // Export-name lookup first (handles `export { X as Y }`), then the
      // symbol's own name (pre-existing behavior for plain named exports).
      const targetSymbol =
        targetExports.get(importedName) ??
        targetSymbols.find((symbol) => symbol.name === importedName)?.id;
      if (targetSymbol) {
        imports.set(localName, targetSymbol);
      }
    }

    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) {
      // `export default function Panel` stores the symbol under "Panel"; the
      // export map knows "default" points at it.
      const targetSymbol =
        targetExports.get("default") ??
        targetSymbols.find((symbol) => symbol.name === "default")?.id;
      if (targetSymbol) {
        imports.set(defaultImport.getText(), targetSymbol);
      }
    }
  }

  return imports;
}

function resolveRelativeModule(
  fromFilePath: string,
  moduleSpecifier: string,
  fileSymbols: Map<string, CodeSymbol[]>
): string | null {
  if (!moduleSpecifier.startsWith(".")) {
    return null;
  }

  const base = normalizePath(posix.join(dirname(normalizePath(fromFilePath)), moduleSpecifier));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
    `${base}/index.mjs`
  ];

  return candidates.find((candidate) => fileSymbols.has(candidate)) ?? null;
}

function nodeForSymbol(sourceFile: SourceFile, symbol: CodeSymbol): Node | null {
  if (symbol.name.includes(".")) {
    const [className, memberName] = symbol.name.split(".", 2);
    const classDeclaration = sourceFile.getClass(className);
    const member = classDeclaration
      ?.getMembers()
      .find(
        (candidate) =>
          (Node.isMethodDeclaration(candidate) || Node.isPropertyDeclaration(candidate)) &&
          candidate.getName() === memberName
      );
    return member ?? null;
  }

  switch (symbol.kind) {
    case "function":
      return sourceFile.getFunction(symbol.name) ?? null;
    case "class":
      return sourceFile.getClass(symbol.name) ?? null;
    case "interface":
      return sourceFile.getInterface(symbol.name) ?? null;
    case "type":
      return sourceFile.getTypeAlias(symbol.name) ?? null;
    case "enum":
      return sourceFile.getEnum(symbol.name) ?? null;
    case "const":
      return sourceFile.getVariableDeclaration(symbol.name) ?? null;
    case "field":
    case "method":
    case "route":
    case "schema":
      return null;
  }
}

function symbolsForDeclaration(
  sourceFile: SourceFile,
  filePath: string,
  declaration: Node,
  exportName?: string
): CodeSymbol[] {
  if (Node.isFunctionDeclaration(declaration)) {
    return symbolName(declaration) ? [functionSymbol(sourceFile, filePath, declaration)] : [];
  }

  if (Node.isClassDeclaration(declaration)) {
    return classSymbols(sourceFile, filePath, declaration);
  }

  if (Node.isInterfaceDeclaration(declaration)) {
    return [textSymbol(sourceFile, filePath, declaration, "interface", declaration.getName())];
  }

  if (Node.isTypeAliasDeclaration(declaration)) {
    return [textSymbol(sourceFile, filePath, declaration, "type", declaration.getName())];
  }

  if (Node.isEnumDeclaration(declaration)) {
    return [textSymbol(sourceFile, filePath, declaration, "enum", declaration.getName())];
  }

  if (Node.isVariableDeclaration(declaration)) {
    return [variableSymbol(sourceFile, filePath, declaration)];
  }

  // `export default (props) => …` / `export default function () {}`: the
  // declaration is the expression itself (common for JSX components). Name it
  // by its export so the contract is tracked instead of silently skipped.
  if (
    exportName &&
    (Node.isArrowFunction(declaration) || Node.isFunctionExpression(declaration))
  ) {
    return [
      buildSymbol({
        sourceFile,
        filePath,
        node: declaration,
        kind: "function",
        name: exportName,
        signature: callableSignature("function", exportName, declaration)
      })
    ];
  }

  return [];
}

function functionSymbol(
  sourceFile: SourceFile,
  filePath: string,
  declaration: FunctionDeclaration
): CodeSymbol {
  const name = symbolName(declaration);
  return buildSymbol({
    sourceFile,
    filePath,
    node: declaration,
    kind: "function",
    name,
    signature: callableSignature("function", name, declaration)
  });
}

function classSymbols(
  sourceFile: SourceFile,
  filePath: string,
  declaration: ClassDeclaration
): CodeSymbol[] {
  const className = symbolName(declaration);
  const symbols: CodeSymbol[] = [
    buildSymbol({
      sourceFile,
      filePath,
      node: declaration,
      kind: "class",
      name: className,
      signature: {
        params: [],
        returns: null,
        raw: `class ${className}`
      }
    })
  ];

  for (const member of declaration.getMembers()) {
    if (!isPublicClassMember(member)) {
      continue;
    }

    if (Node.isMethodDeclaration(member)) {
      const memberName = member.getName();
      const name = `${className}.${memberName}`;
      symbols.push(
        buildSymbol({
          sourceFile,
          filePath,
          node: member,
          kind: "method",
          name,
          signature: callableSignature("method", name, member)
        })
      );
    }

    if (Node.isPropertyDeclaration(member)) {
      const name = `${className}.${member.getName()}`;
      symbols.push(
        buildSymbol({
          sourceFile,
          filePath,
          node: member,
          kind: "field",
          name,
          signature: fieldSignature(name, member)
        })
      );
    }
  }

  return symbols;
}

function textSymbol(
  sourceFile: SourceFile,
  filePath: string,
  declaration: InterfaceDeclaration | TypeAliasDeclaration | EnumDeclaration,
  kind: Extract<SymbolKind, "interface" | "type" | "enum">,
  name: string
): CodeSymbol {
  return buildSymbol({
    sourceFile,
    filePath,
    node: declaration,
    kind,
    name,
    signature: {
      params: [],
      returns: null,
      raw: normalizeText(declaration.getText())
    }
  });
}

function variableSymbol(
  sourceFile: SourceFile,
  filePath: string,
  declaration: VariableDeclaration
): CodeSymbol {
  const name = declaration.getName();
  const type = declaration.getType().getText(declaration);

  return buildSymbol({
    sourceFile,
    filePath,
    node: declaration,
    kind: "const",
    name,
    signature: {
      params: [],
      returns: type,
      raw: `const ${name}: ${type}`
    }
  });
}

function buildSymbol(input: {
  sourceFile: SourceFile;
  filePath: string;
  node: Node;
  kind: SymbolKind;
  name: string;
  signature: Signature;
}): CodeSymbol {
  const normalizedSignature = {
    ...input.signature,
    raw: normalizeText(input.signature.raw)
  };

  return {
    id: symbolId(input.filePath, input.name),
    kind: input.kind,
    name: input.name,
    visibility: "exported",
    signature: normalizedSignature,
    sigHash: hashSignature(normalizedSignature),
    span: spanFor(input.filePath, input.sourceFile, input.node),
    lang: "ts"
  };
}

function callableSignature(
  label: "function" | "method",
  name: string,
  declaration: FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression
): Signature {
  const params = declaration.getParameters().map((param): SignatureParam => {
    const type = param.getType().getText(param);
    return {
      name: param.getName(),
      type,
      optional: param.isOptional() || param.hasInitializer()
    };
  });
  const generics = declaration.getTypeParameters().map((typeParam) => typeParam.getName());
  const returns = declaration.getReturnType().getText(declaration);
  const typeParams = generics.length > 0 ? `<${generics.join(", ")}>` : "";
  const paramsText = params
    .map((param) => `${param.name}${param.optional ? "?" : ""}: ${param.type ?? "unknown"}`)
    .join(", ");

  return {
    params,
    returns,
    generics: generics.length > 0 ? generics : undefined,
    raw: `${label} ${name}${typeParams}(${paramsText}): ${returns}`
  };
}

function fieldSignature(name: string, declaration: PropertyDeclaration): Signature {
  const type = declaration.getType().getText(declaration);
  return {
    params: [],
    returns: type,
    raw: `field ${name}: ${type}`
  };
}

function isPublicClassMember(member: Node): boolean {
  if (
    (Node.isMethodDeclaration(member) || Node.isPropertyDeclaration(member)) &&
    (member.hasModifier("private") || member.hasModifier("protected"))
  ) {
    return false;
  }

  return Node.isMethodDeclaration(member) || Node.isPropertyDeclaration(member);
}

function symbolName(declaration: FunctionDeclaration | ClassDeclaration): string {
  return declaration.getName() ?? "default";
}

function spanFor(filePath: string, sourceFile: SourceFile, node: Node): CodeSymbol["span"] {
  // `getExportedDeclarations()` follows re-exports, so `node` can live in a
  // different file than the one being scanned. Positions must be resolved
  // against the node's own source file or they fall outside its length.
  const owner = node.getSourceFile() ?? sourceFile;
  const start = owner.getLineAndColumnAtPos(node.getStart());
  const end = owner.getLineAndColumnAtPos(node.getEnd());

  return {
    path: normalizePath(filePath),
    startLine: start.line,
    endLine: end.line
  };
}

function symbolId(filePath: string, name: string): SymbolId {
  return {
    raw: `ts:${normalizePath(filePath)}#${name}`
  };
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hashSignature(signature: Signature): string {
  return createHash("sha256").update(signature.raw).digest("hex");
}

function bySymbolId(symbols: CodeSymbol[]): Map<string, CodeSymbol> {
  return new Map(symbols.map((symbol) => [symbol.id.raw, symbol]));
}
