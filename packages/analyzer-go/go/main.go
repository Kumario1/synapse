// Long-lived JSON-RPC-over-stdio analyzer sidecar for Go (plan M12).
//
// Reads newline-delimited JSON requests on stdin and writes one
// newline-delimited JSON response per request on stdout — the same wire
// protocol as the Python sidecar, so the Node wrapper is interchangeable.
// Stays warm so the daemon pays process startup once. Every request is
// isolated: a handler error returns a structured `error` instead of killing
// the loop, so one bad file never takes the analyzer down.
//
// Only structural facts are read (go/parser + go/ast) — never executed.
// Exported = uppercase initial, Go's own visibility rule.
//
// Request:  {"id": <any>, "method": "health"|"extractFile"|"indexGraph", "params": {...}}
// Response: {"id": <any>, "result": {...}}  |  {"id": <any>, "error": {"message": "..."}}
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
)

const version = "0.0.0"

type request struct {
	ID     any             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type response struct {
	ID     any       `json:"id"`
	Result any       `json:"result,omitempty"`
	Error  *rpcError `json:"error,omitempty"`
}

type rpcError struct {
	Message string `json:"message"`
}

type fileInput struct {
	FilePath string `json:"filePath"`
	Source   string `json:"source"`
}

type extractParams fileInput

type graphParams struct {
	Files []fileInput `json:"files"`
}

// Mirrors the protocol's CodeSymbol shape.
type symbolID struct {
	Raw string `json:"raw"`
}

type signatureParam struct {
	Name     string  `json:"name"`
	Type     *string `json:"type"`
	Optional bool    `json:"optional"`
}

type signature struct {
	Params  []signatureParam `json:"params"`
	Returns *string          `json:"returns"`
	Raw     string           `json:"raw"`
}

type span struct {
	Path      string `json:"path"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
}

type codeSymbol struct {
	ID         symbolID  `json:"id"`
	Kind       string    `json:"kind"`
	Name       string    `json:"name"`
	Visibility string    `json:"visibility"`
	Signature  signature `json:"signature"`
	SigHash    string    `json:"sigHash"`
	Span       span      `json:"span"`
	Lang       string    `json:"lang"`
}

type edge struct {
	From symbolID `json:"from"`
	To   symbolID `json:"to"`
	Kind string   `json:"kind"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	out := bufio.NewWriter(os.Stdout)
	encoder := json.NewEncoder(out)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var req request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			_ = encoder.Encode(response{ID: nil, Error: &rpcError{Message: "invalid JSON: " + err.Error()}})
			_ = out.Flush()
			continue
		}

		result, err := handle(req)
		if err != nil {
			_ = encoder.Encode(response{ID: req.ID, Error: &rpcError{Message: err.Error()}})
		} else {
			_ = encoder.Encode(response{ID: req.ID, Result: result})
		}
		_ = out.Flush()
	}
}

func handle(req request) (any, error) {
	switch req.Method {
	case "health":
		return map[string]any{"ok": true, "version": version, "lang": "go"}, nil
	case "extractFile":
		var params extractParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, err
		}
		symbols, err := extractFile(params.FilePath, params.Source)
		if err != nil {
			return nil, err
		}
		return map[string]any{"symbols": symbols}, nil
	case "indexGraph":
		var params graphParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, err
		}
		return indexGraph(params.Files)
	default:
		return nil, fmt.Errorf("unknown method: %s", req.Method)
	}
}

var whitespace = regexp.MustCompile(`\s+`)

func normalizeText(text string) string {
	return strings.TrimSpace(whitespace.ReplaceAllString(text, " "))
}

func normalizePath(p string) string {
	return strings.ReplaceAll(p, "\\", "/")
}

func sigHash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func makeSymbolID(filePath, name string) symbolID {
	return symbolID{Raw: "go:" + normalizePath(filePath) + "#" + name}
}

type parsedFile struct {
	filePath string
	fset     *token.FileSet
	file     *ast.File
	source   string
}

func parseSource(filePath, source string) (*parsedFile, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filePath, source, parser.ParseComments)
	if err != nil {
		return nil, err
	}
	return &parsedFile{filePath: normalizePath(filePath), fset: fset, file: file, source: source}, nil
}

func extractFile(filePath, source string) ([]codeSymbol, error) {
	parsed, err := parseSource(filePath, source)
	if err != nil {
		return nil, err
	}
	return extractSymbols(parsed), nil
}

func extractSymbols(parsed *parsedFile) []codeSymbol {
	symbols := []codeSymbol{}

	for _, decl := range parsed.file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			symbols = append(symbols, funcSymbols(parsed, d)...)
		case *ast.GenDecl:
			symbols = append(symbols, genDeclSymbols(parsed, d)...)
		}
	}

	sort.Slice(symbols, func(i, j int) bool { return symbols[i].ID.Raw < symbols[j].ID.Raw })
	return symbols
}

func funcSymbols(parsed *parsedFile, decl *ast.FuncDecl) []codeSymbol {
	if !decl.Name.IsExported() {
		return nil
	}

	name := decl.Name.Name
	kind := "function"
	label := "func"

	if decl.Recv != nil && len(decl.Recv.List) > 0 {
		receiver := receiverTypeName(decl.Recv.List[0].Type)
		if receiver == "" || !ast.IsExported(receiver) {
			return nil
		}
		name = receiver + "." + name
		kind = "method"
	}

	params, paramsText := fieldListParams(parsed, decl.Type.Params)
	returns := resultsText(parsed, decl.Type.Results)
	raw := normalizeText(fmt.Sprintf("%s %s(%s)%s", label, name, paramsText, formatReturns(returns)))

	return []codeSymbol{buildSymbol(parsed, decl, kind, name, signature{
		Params:  params,
		Returns: returns,
		Raw:     raw,
	})}
}

func genDeclSymbols(parsed *parsedFile, decl *ast.GenDecl) []codeSymbol {
	symbols := []codeSymbol{}

	for _, spec := range decl.Specs {
		switch s := spec.(type) {
		case *ast.TypeSpec:
			symbols = append(symbols, typeSymbols(parsed, s)...)
		case *ast.ValueSpec:
			for _, ident := range s.Names {
				if !ident.IsExported() {
					continue
				}
				typeText := nodeText(parsed, s.Type)
				if typeText == "" {
					typeText = "untyped"
				}
				raw := normalizeText(fmt.Sprintf("const %s: %s", ident.Name, typeText))
				returns := typeText
				symbols = append(symbols, buildSymbol(parsed, s, "const", ident.Name, signature{
					Params:  []signatureParam{},
					Returns: &returns,
					Raw:     raw,
				}))
			}
		}
	}

	return symbols
}

func typeSymbols(parsed *parsedFile, spec *ast.TypeSpec) []codeSymbol {
	if !spec.Name.IsExported() {
		return nil
	}

	name := spec.Name.Name
	switch t := spec.Type.(type) {
	case *ast.StructType:
		symbols := []codeSymbol{buildSymbol(parsed, spec, "class", name, signature{
			Params:  []signatureParam{},
			Returns: nil,
			Raw:     normalizeText("struct " + name),
		})}
		if t.Fields != nil {
			for _, field := range t.Fields.List {
				typeText := nodeText(parsed, field.Type)
				for _, ident := range field.Names {
					if !ident.IsExported() {
						continue
					}
					fieldName := name + "." + ident.Name
					returns := typeText
					symbols = append(symbols, buildSymbol(parsed, field, "field", fieldName, signature{
						Params:  []signatureParam{},
						Returns: &returns,
						Raw:     normalizeText(fmt.Sprintf("field %s: %s", fieldName, typeText)),
					}))
				}
			}
		}
		return symbols
	case *ast.InterfaceType:
		return []codeSymbol{buildSymbol(parsed, spec, "interface", name, signature{
			Params:  []signatureParam{},
			Returns: nil,
			Raw:     normalizeText("interface " + name + " " + nodeText(parsed, t)),
		})}
	default:
		return []codeSymbol{buildSymbol(parsed, spec, "type", name, signature{
			Params:  []signatureParam{},
			Returns: nil,
			Raw:     normalizeText("type " + name + " " + nodeText(parsed, spec.Type)),
		})}
	}
}

func buildSymbol(parsed *parsedFile, node ast.Node, kind, name string, sig signature) codeSymbol {
	start := parsed.fset.Position(node.Pos())
	end := parsed.fset.Position(node.End())

	return codeSymbol{
		ID:         makeSymbolID(parsed.filePath, name),
		Kind:       kind,
		Name:       name,
		Visibility: "exported",
		Signature:  sig,
		SigHash:    sigHash(sig.Raw),
		Span: span{
			Path:      parsed.filePath,
			StartLine: start.Line,
			EndLine:   end.Line,
		},
		Lang: "go",
	}
}

func receiverTypeName(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return receiverTypeName(t.X)
	case *ast.IndexExpr: // generic receiver: (r *T[P])
		return receiverTypeName(t.X)
	case *ast.IndexListExpr:
		return receiverTypeName(t.X)
	default:
		return ""
	}
}

func fieldListParams(parsed *parsedFile, fields *ast.FieldList) ([]signatureParam, string) {
	params := []signatureParam{}
	parts := []string{}
	if fields == nil {
		return params, ""
	}

	for index, field := range fields.List {
		typeText := nodeText(parsed, field.Type)
		if len(field.Names) == 0 {
			t := typeText
			params = append(params, signatureParam{Name: fmt.Sprintf("arg%d", index), Type: &t, Optional: false})
			parts = append(parts, typeText)
			continue
		}
		for _, ident := range field.Names {
			t := typeText
			params = append(params, signatureParam{Name: ident.Name, Type: &t, Optional: false})
			parts = append(parts, ident.Name+" "+typeText)
		}
	}

	return params, strings.Join(parts, ", ")
}

func resultsText(parsed *parsedFile, results *ast.FieldList) *string {
	if results == nil || len(results.List) == 0 {
		return nil
	}

	parts := []string{}
	for _, field := range results.List {
		typeText := nodeText(parsed, field.Type)
		count := len(field.Names)
		if count == 0 {
			count = 1
		}
		for i := 0; i < count; i++ {
			parts = append(parts, typeText)
		}
	}

	text := strings.Join(parts, ", ")
	if len(parts) > 1 {
		text = "(" + text + ")"
	}
	return &text
}

func formatReturns(returns *string) string {
	if returns == nil {
		return ""
	}
	return " " + *returns
}

func nodeText(parsed *parsedFile, node ast.Node) string {
	if node == nil {
		return ""
	}
	start := parsed.fset.Position(node.Pos()).Offset
	end := parsed.fset.Position(node.End()).Offset
	if start < 0 || end > len(parsed.source) || start >= end {
		return ""
	}
	return normalizeText(parsed.source[start:end])
}

// indexGraph builds {symbols, edges} over a file set. Two reference shapes:
//   - same package (same directory): a bare identifier in one symbol's body
//     matching an exported symbol declared in another file of that directory;
//   - cross package: a selector `pkg.Name` where `pkg` is an import whose path
//     suffix matches another directory in the set.
func indexGraph(files []fileInput) (any, error) {
	parsedFiles := []*parsedFile{}
	symbolsByFile := map[string][]codeSymbol{}
	allSymbols := map[string]codeSymbol{}

	for _, file := range files {
		parsed, err := parseSource(file.FilePath, file.Source)
		if err != nil {
			continue // a malformed file degrades to no symbols, never an error
		}
		parsedFiles = append(parsedFiles, parsed)
		symbols := extractSymbols(parsed)
		symbolsByFile[parsed.filePath] = symbols
		for _, symbol := range symbols {
			allSymbols[symbol.ID.Raw] = symbol
		}
	}

	// name → symbol id, per directory (Go package ≈ directory).
	byDir := map[string]map[string]symbolID{}
	for filePath, symbols := range symbolsByFile {
		dir := path.Dir(filePath)
		if byDir[dir] == nil {
			byDir[dir] = map[string]symbolID{}
		}
		for _, symbol := range symbols {
			byDir[dir][symbol.Name] = symbol.ID
			// Methods/fields also index under their bare member name's owner:
			// `T.Method` is reachable through identifier `T` references too.
		}
	}

	edges := map[string]edge{}

	for _, parsed := range parsedFiles {
		dir := path.Dir(parsed.filePath)
		imports := importAliases(parsed)
		symbols := symbolsByFile[parsed.filePath]

		for _, symbol := range symbols {
			node := nodeForSymbol(parsed, symbol)
			if node == nil {
				continue
			}

			ast.Inspect(node, func(n ast.Node) bool {
				switch ref := n.(type) {
				case *ast.SelectorExpr:
					pkgIdent, ok := ref.X.(*ast.Ident)
					if !ok {
						return true
					}
					importPath, isImport := imports[pkgIdent.Name]
					if !isImport {
						return true
					}
					targetDir := dirForImport(importPath, byDir)
					if targetDir == "" {
						return true
					}
					if target, found := byDir[targetDir][ref.Sel.Name]; found && target.Raw != symbol.ID.Raw {
						edges[symbol.ID.Raw+"->"+target.Raw] = edge{From: symbol.ID, To: target, Kind: "references"}
					}
					return true
				case *ast.Ident:
					if target, found := byDir[dir][ref.Name]; found && target.Raw != symbol.ID.Raw {
						// Same-package reference; skip self-file hits to the
						// declaration identifier itself by requiring another file.
						if !strings.HasPrefix(target.Raw, "go:"+parsed.filePath+"#") {
							edges[symbol.ID.Raw+"->"+target.Raw] = edge{From: symbol.ID, To: target, Kind: "references"}
						}
					}
					return true
				}
				return true
			})
		}
	}

	symbolList := make([]codeSymbol, 0, len(allSymbols))
	for _, symbol := range allSymbols {
		symbolList = append(symbolList, symbol)
	}
	sort.Slice(symbolList, func(i, j int) bool { return symbolList[i].ID.Raw < symbolList[j].ID.Raw })

	edgeList := make([]edge, 0, len(edges))
	for _, e := range edges {
		edgeList = append(edgeList, e)
	}
	sort.Slice(edgeList, func(i, j int) bool {
		return edgeList[i].From.Raw+"->"+edgeList[i].To.Raw < edgeList[j].From.Raw+"->"+edgeList[j].To.Raw
	})

	return map[string]any{"symbols": symbolList, "edges": edgeList}, nil
}

func importAliases(parsed *parsedFile) map[string]string {
	aliases := map[string]string{}
	for _, imp := range parsed.file.Imports {
		importPath := strings.Trim(imp.Path.Value, `"`)
		name := path.Base(importPath)
		if imp.Name != nil && imp.Name.Name != "_" && imp.Name.Name != "." {
			name = imp.Name.Name
		}
		aliases[name] = importPath
	}
	return aliases
}

// dirForImport maps an import path onto a directory present in the file set by
// longest suffix match (the set is rooted at the worktree, import paths at the
// module path — the tail segments line up).
func dirForImport(importPath string, byDir map[string]map[string]symbolID) string {
	best := ""
	for dir := range byDir {
		if dir == "." {
			continue
		}
		if strings.HasSuffix(importPath, dir) || strings.HasSuffix(dir, importPath) {
			if len(dir) > len(best) {
				best = dir
			}
		} else if path.Base(importPath) == path.Base(dir) {
			if best == "" {
				best = dir
			}
		}
	}
	return best
}

func nodeForSymbol(parsed *parsedFile, symbol codeSymbol) ast.Node {
	for _, decl := range parsed.file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			name := d.Name.Name
			if d.Recv != nil && len(d.Recv.List) > 0 {
				name = receiverTypeName(d.Recv.List[0].Type) + "." + name
			}
			if name == symbol.Name {
				return d
			}
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					if s.Name.Name == symbol.Name {
						return s
					}
				case *ast.ValueSpec:
					for _, ident := range s.Names {
						if ident.Name == symbol.Name {
							return s
						}
					}
				}
			}
		}
	}
	return nil
}
