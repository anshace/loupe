/**
 * Minimal ambient declaration for the OPTIONAL `web-tree-sitter` dependency.
 * The package is declared in optionalDependencies and loaded via dynamic
 * import at runtime; this stub keeps the strict TS build green whether or not
 * the module (and its type definitions) is actually installed.
 */
declare module "web-tree-sitter" {
  export interface Point {
    row: number;
    column: number;
  }

  export interface SyntaxNode {
    type: string;
    startPosition: Point;
    endPosition: Point;
    parent: SyntaxNode | null;
    namedDescendantForPosition(start: Point, end: Point): SyntaxNode;
  }

  export interface Tree {
    rootNode: SyntaxNode;
  }

  export class Language {
    static load(pathOrBytes: string | Uint8Array): Promise<Language>;
  }

  export class Parser {
    static init(options?: Record<string, unknown>): Promise<void>;
    setLanguage(language: Language): void;
    parse(input: string): Tree | null;
  }
}
