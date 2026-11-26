// Citation shown under an answer (one per evidence item the answer can cite).

export interface Citation {
  text: string;
  chunkIndex: number;
  docName: string;
  pageNum: number;
  rerankScore: number;
  method: "dense" | "sparse" | "hybrid";
  /** 1-based bracket index this evidence had in the synthesis prompt context
   *  (position in `fused.evidence` + 1). The display numbering
   *  (lib/citation-display.ts) maps it to the number on the evidence card, so a [N]
   *  in the answer and the verifier's match open the same card. When absent, the
   *  array position + 1 is used. */
  bracketNum?: number;
  citedInAnswer?: boolean;
}
