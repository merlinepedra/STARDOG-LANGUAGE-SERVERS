import {
  CompletionItem,
  CompletionItemKind,
  FoldingRangeRequestParam,
  IConnection,
  InitializeParams,
  InitializeResult,
  InsertTextFormat,
  Range,
  TextDocumentChangeEvent,
  TextDocumentPositionParams,
  TextEdit,
} from 'vscode-languageserver';
import { autoBindMethods } from 'class-autobind-decorator';
import {
  errorMessageProvider,
  AbstractLanguageServer,
  sms2Snippets,
} from 'stardog-language-utils';
import { SmsParser } from 'millan';

@autoBindMethods
export class SmsLanguageServer extends AbstractLanguageServer<SmsParser> {
  constructor(connection: IConnection) {
    super(connection, new SmsParser({ errorMessageProvider }));
  }

  onInitialization(_params: InitializeParams): InitializeResult {
    this.connection.onCompletion(this.handleCompletion);
    this.connection.onFoldingRanges((params: FoldingRangeRequestParam) =>
      this.handleFoldingRanges(params, true, false)
    );

    return {
      capabilities: {
        // Tell the client that the server works in NONE text document sync mode
        textDocumentSync: this.documents.syncKind[0],
        hoverProvider: true,
        foldingRangeProvider: true,
        completionProvider: {
          triggerCharacters: ['<', ':', '?', '$'],
        },
      },
    };
  }

  onContentChange(
    { document }: TextDocumentChangeEvent,
    parseResults: ReturnType<AbstractLanguageServer<SmsParser>['parseDocument']>
  ): void {
    const { uri } = document;
    const content = document.getText();
    const { errors, tokens } = parseResults;

    if (!content.length) {
      this.connection.sendDiagnostics({
        uri,
        diagnostics: [],
      });
      return;
    }

    const lexDiagnostics = this.getLexDiagnostics(document, tokens);
    const parseDiagnostics = this.getParseDiagnostics(document, errors);

    return this.connection.sendDiagnostics({
      uri,
      diagnostics: [...lexDiagnostics, ...parseDiagnostics],
    });
  }

  handleCompletion(params: TextDocumentPositionParams): CompletionItem[] {
    const { uri } = params.textDocument;
    const document = this.documents.get(uri);
    const cursorOffset = document.offsetAt(params.position);
    let { tokens } = this.parseStateManager.getParseStateForUri(uri);

    if (!tokens) {
      const { tokens: newTokens, cst } = this.parseDocument(document);
      tokens = newTokens;
      this.parseStateManager.saveParseStateForUri(uri, { cst, tokens });
    }

    let tokenIndexBeforeCursor = -1;
    for (let index = tokens.length - 1; index > -1; index--) {
      const token = tokens[index];
      if (token.endOffset + 1 < cursorOffset) {
        tokenIndexBeforeCursor = index;
        break;
      }
    }

    const tokenAfterTokenBeforeCursor = tokens[tokenIndexBeforeCursor + 1];
    const isCursorInToken =
      tokenAfterTokenBeforeCursor &&
      tokenAfterTokenBeforeCursor.startOffset <= cursorOffset &&
      tokenAfterTokenBeforeCursor.endOffset >= cursorOffset &&
      tokenAfterTokenBeforeCursor.startOffset !==
        tokenAfterTokenBeforeCursor.endOffset;

    if (isCursorInToken) {
      // For now, this server only handles completion for snippets, which
      // should never be placed in the middle of a token, so we bail early.
      return;
    }

    const completions = this.parser.computeContentAssist(
      'MappingDoc',
      tokenIndexBeforeCursor === -1
        ? []
        : tokens.slice(0, tokenIndexBeforeCursor + 1)
    );

    if (
      completions.some(
        (completion) => completion.nextTokenType.tokenName === 'Mapping'
      )
    ) {
      return [
        {
          label: 'basicSMS2Mapping',
          kind: CompletionItemKind.Enum,
          detail: 'Create a basic fill-in-the-blanks SMS2 mapping',
          documentation:
            'Inserts a basic mapping in Stardog Mapping Syntax 2 (SMS2) with tabbing functionality and content assistance. For more documentation of SMS2, check out "Help" --> "Stardog Docs".',
          insertTextFormat: InsertTextFormat.Snippet,
          textEdit: TextEdit.replace(
            Range.create(
              document.positionAt(cursorOffset - 1),
              document.positionAt(cursorOffset - 1)
            ),
            sms2Snippets.basicSMS2Mapping
          ),
        },
      ];
    }
  }
}
