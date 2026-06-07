import { createHash } from "node:crypto";
import {
  ClassDeclaration,
  EnumDeclaration,
  FunctionDeclaration,
  InterfaceDeclaration,
  MethodDeclaration,
  ModuleKind,
  Node,
  Project,
  ScriptTarget,
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

export function extractTypeScriptContracts(
  input: ExtractTypeScriptContractsInput
): ExtractTypeScriptContractsResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      allowJs: true,
      target: ScriptTarget.ES2022,
      module: ModuleKind.ESNext,
      strict: true
    }
  });
  const sourceFile = project.createSourceFile(input.filePath, input.source, { overwrite: true });
  const symbols = new Map<string, CodeSymbol>();

  for (const declarations of sourceFile.getExportedDeclarations().values()) {
    for (const declaration of declarations) {
      for (const symbol of symbolsForDeclaration(sourceFile, input.filePath, declaration)) {
        symbols.set(symbol.id.raw, symbol);
      }
    }
  }

  return {
    symbols: [...symbols.values()].sort((a, b) => a.id.raw.localeCompare(b.id.raw))
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

function symbolsForDeclaration(
  sourceFile: SourceFile,
  filePath: string,
  declaration: Node
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
  declaration: FunctionDeclaration | MethodDeclaration
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
  const start = sourceFile.getLineAndColumnAtPos(node.getStart());
  const end = sourceFile.getLineAndColumnAtPos(node.getEnd());

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
