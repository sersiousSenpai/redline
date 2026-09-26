# Polis memory: recall through basins of attraction

Date: 2026-09-07  
Status: exploratory research hypothesis; not an approved implementation change.

## Source and purpose

The user supplied definition-popup notes for storage and synthesis after a discussion of context-dependent recall, quantum-inspired models, and Mandelbrot/Julia-set dynamics. The exact supplied text is preserved in [the source notes](polis-basin-attractor-source-2026-09-07.txt). This document synthesizes that proposal and qualifies its claims; it does not direct the external session executing the standalone Polis plan.

## Central hypothesis

Polis could represent a query together with the user's current situation as an initial state. A learned associative process could then resolve that state toward one or more recorded episodes. Different cues could recover the same episode while emphasizing different aspects of it.

For example, an episode might record that architecture X was rejected because it violated standalone operation, that Y was selected, and what subsequently happened. Questions about the rejection, the constraint, the replacement, or repeating the approach could all retrieve that episode. The outcome must come from recorded evidence: selecting Y does not establish that Y worked.

The proposed computation is:

\[
h_0 = E(q,C), \qquad h_{t+1}=F_\theta(h_t,\mathcal M)
\]

Here, `q` is the submitted query; `C` is permitted project, conversation, task, artifact, and temporal context; `M` is the current memory index. These equations specify an architecture sketch, not a trained algorithm or a convergence guarantee.

An attractor would identify an evidence-backed episode or set of episodes. Its basin would contain query/context states that resolve toward it. Retrieval should return source identifiers and evidence, rather than treating a converged latent vector as proof.

## What this adds to the Polis discussion

- **Episodes as retrieval units.** Bind decision, rationale, constraints, outcome, exceptions, and citations, allowing unknown fields. The same episode can support different questions.
- **Context-conditioned associations.** A vague query such as “Should we do that again?” gains meaning from the current task. Some context may influence ranking; authorization and source visibility must remain hard constraints.
- **Learned boundaries.** Similar questions about a local application and a distributed service should activate different experiences when their operating conditions differ.
- **Continuous adaptation.** New evidence and observed outcomes could update associations while preserving older evidence and the circumstances in which it applied.
- **Recall at handoff.** A host could run bounded retrieval on submission and supply the resulting cited context to the answering model before its first reasoning step. This requires host integration; MCP availability alone does not guarantee it.

## Qualifications that matter

**Context is not exclusive to attractor models.** An ordinary embedding retriever can encode the same query plus context, and a reranker can examine both. The proposal's advantage must therefore come from its representation or dynamics, not merely from giving it information withheld from the baseline.

**Convergence is not correctness.** A system can confidently settle on the wrong episode. It needs ambiguity handling, an abstention path, and tests for spurious or mixed attractors. Some questions require several episodes and should never be forced into one destination.

**Fractal structure is an inspiration, not a requirement.** Mandelbrot and Julia sets do not automatically encode semantic knowledge. Sensitive boundaries could make recall unstable under paraphrase. The desired property is stability under irrelevant changes and responsiveness to meaningful contextual changes; fractality itself is not a success metric.

**Speed is unproven.** Several cheap updates might outperform an agent's repeated search calls, but they might lose to one well-indexed retrieval pass. Measure encoding, candidate access, iteration, evidence fetching, and context assembly together, including maintenance cost.

**Feedback needs independent evidence.** Frequent retrieval or an agent's unverified approval does not establish usefulness. Reinforcing whatever the current retriever already selects could amplify its errors. Task outcomes and explicit corrections are stronger candidates for learning signals, though attributing an outcome to one memory remains difficult.

**This can still be a retrieval-augmented system.** If it retrieves evidence for a language model, it remains within a broad RAG design. The potentially novel contribution is how experience is represented, associated, and selected; replacing that label is not necessary.

## Fit with the planned system

The lake would remain the record of evidence. Episodes and learned associations would be additional derived structures, alongside the catalog, lexical index, and embeddings. They should carry citations and index/model versions, be replaceable without altering the evidence, and honor forgetting and supersession.

The memory gardener is the natural candidate for preparing these structures. The supplied notes call this role the “librarian”; in the reviewed implementation, the keeper/gardener performs background memory maintenance, while the Librarian diagnoses workspace friction.

Existing claims could contribute to an episode, but atomic claims and episodes are different representations. A claim states something; an episode preserves the circumstances and sequence connecting assertions, actions, and outcomes.

## Smallest useful experiment

Use a fixed corpus of cited decision episodes, with held-out queries covering paraphrases, vague references, contextual changes, supersession, conflicting evidence, and questions requiring multiple episodes.

Compare three configurations with the same available context and evidence budget:

1. The existing hybrid retriever, supplied with contextualized queries.
2. The same retriever using episode representations.
3. The same episode representations with a bounded associative update process.

This separates gains from contextual input, episode construction, and retrieval dynamics. Split evaluation by episode or project so paraphrases of training examples cannot masquerade as generalization. Test incremental additions and forgetting as well as a frozen index.

Measure evidence recall, downstream answer quality, incorrect confident recall, paraphrase consistency, sensitivity to relevant context, p50/p95 end-to-end latency, and maintenance cost. Keep a simple retrieval fallback. Numerical adoption thresholds remain undecided.

## Related research already identified in the discussion

- [Modern Hopfield networks](https://arxiv.org/abs/2008.02217): associative retrieval and its relationship to attention; a closer starting point for implementation than directly adopting quadratic Julia dynamics.
- [A Chaotic Associative Memory](https://arxiv.org/abs/2401.10922): an investigation of oscillatory/chaotic associative memory, not evidence of improved Polis or language-agent retrieval.
- [RAPTOR](https://arxiv.org/abs/2401.18059): retrieval across recursively constructed abstraction levels; relevant to recovering both an episode and its underlying details.

The retained research question is: **Can a context-conditioned associative process recover complete, cited episodes more reliably or efficiently than a context-aware hybrid retriever using the same evidence?**
