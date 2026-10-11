import documentParsingWorker from "./document-parsing-worker";

type ProofEnvironment = Readonly<{
  PARSER_PROOF: DurableObjectNamespace;
  XLSX_PROOF_KEY: string;
}>;

/** Isolated synthetic compute only; no production storage or outbound provider binding. */
export class XlsxParserProof {
  fetch(request: Request): Promise<Response> {
    return documentParsingWorker.fetch(request);
  }
}

const fetch = (request: Request, env: ProofEnvironment): Promise<Response> => {
  if (request.headers.get("X-Xlsx-Proof-Key") !== env.XLSX_PROOF_KEY) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  return env.PARSER_PROOF.get(env.PARSER_PROOF.idFromName("synthetic-parser")).fetch(request);
};

export default { fetch };
