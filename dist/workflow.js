function toolNode(id, toolName, options) {
  return {
    kind: 'tool',
    id,
    toolName,
    input: options?.input,
    retry: options?.retry,
    timeoutMs: options?.timeoutMs,
  };
}
function sequenceNode(id, steps) {
  return { kind: 'sequence', id, steps };
}
function parallelNode(id, steps, maxConcurrency, failFast) {
  return { kind: 'parallel', id, steps, maxConcurrency, failFast };
}

const workflowId = 'workflow.auth-surface-mapper.v1';

const authSurfaceMapperWorkflow = {
  kind: 'workflow-contract',
  version: 1,
  id: workflowId,
  displayName: 'Auth Surface Mapper',
  description:
    'Enumerates all authentication surfaces on a page: cookies, localStorage tokens, sessionStorage, authorization headers, JWT payloads, CSRF tokens, OAuth parameters, and API keys — producing a unified auth surface report with confidence scores.',
  tags: ['reverse', 'auth', 'token', 'cookie', 'credential', 'jwt', 'csrf', 'mission'],
  timeoutMs: 6 * 60_000,
  defaultMaxConcurrency: 5,

  build(ctx) {
    const prefix = 'workflows.authSurfaceMapper';
    const url = String(ctx.getConfig(`${prefix}.url`, 'https://example.com'));
    const waitUntil = String(ctx.getConfig(`${prefix}.waitUntil`, 'networkidle0'));
    const requestTail = Number(ctx.getConfig(`${prefix}.requestTail`, 50));
    const minConfidence = Number(ctx.getConfig(`${prefix}.minConfidence`, 0.2));
    const maxConcurrency = Number(ctx.getConfig(`${prefix}.parallel.maxConcurrency`, 5));
    const triggerActions = Boolean(ctx.getConfig(`${prefix}.triggerActions`, false));

    const steps = [
      // Phase 1: Network & Navigation
      toolNode('enable-network', 'network_enable', { input: { enableExceptions: true } }),
      toolNode('navigate', 'page_navigate', { input: { url, waitUntil } }),

      // Phase 2: Parallel Surface Collection
      parallelNode(
        'collect-auth-surfaces',
        [
          toolNode('get-cookies', 'page_get_cookies'),
          toolNode('get-local-storage', 'page_get_local_storage'),
          toolNode('get-requests', 'network_get_requests', { input: { tail: requestTail } }),
          toolNode('extract-auth', 'network_extract_auth', { input: { minConfidence } }),
          toolNode('search-auth-patterns', 'search_in_scripts', {
            input: { query: 'authorization,bearer,jwt,token,csrf,x-csrf,api-key,apikey,secret', matchType: 'any' },
          }),
          toolNode('detect-crypto', 'detect_crypto', { input: {} }),
        ],
        maxConcurrency,
        false,
      ),

      // Phase 3: Token Deep Analysis
      toolNode('evaluate-auth-state', 'page_evaluate', {
        input: {
          expression: `(function() {
            const result = {};
            try { result.localStorage = Object.keys(localStorage).filter(k => /token|auth|jwt|session|csrf|key|secret/i.test(k)); } catch(e) {}
            try { result.sessionStorage = Object.keys(sessionStorage).filter(k => /token|auth|jwt|session|csrf|key|secret/i.test(k)); } catch(e) {}
            result.metaTags = [...document.querySelectorAll('meta[name*=csrf], meta[name*=token], meta[name*=auth]')].map(m => ({name:m.name,content:m.content?.slice(0,50)}));
            result.hiddenInputs = [...document.querySelectorAll('input[type=hidden]')].filter(i => /token|csrf|auth|nonce/i.test(i.name)).map(i => ({name:i.name,value:i.value?.slice(0,50)}));
            return result;
          })()`,
        },
      }),
    ];

    // Phase 4: Optional Login Trigger
    if (triggerActions) {
      steps.push(
        toolNode('find-login-buttons', 'dom_find_clickable', { input: {} }),
        toolNode('get-forms', 'dom_query_all', { input: { selector: 'form[action]' } }),
      );
    }

    // Phase 5: Evidence Recording
    steps.push(
      toolNode('create-evidence-session', 'instrumentation_session_create', {
        input: {
          name: `auth-surface-${new Date().toISOString().slice(0, 10)}`,
          metadata: { url, workflowId },
        },
      }),
      toolNode('record-artifact', 'instrumentation_artifact_record', {
        input: {
          type: 'auth_surface_report',
          label: `Auth surface analysis for ${url}`,
          metadata: { url, minConfidence, requestTail },
        },
      }),

      // Phase 6: Session Insight
      toolNode('emit-insight', 'append_session_insight', {
        input: {
          insight: JSON.stringify({
            status: 'auth_surface_mapper_complete',
            workflowId,
            url,
            minConfidence,
          }),
        },
      }),
    );

    return sequenceNode('auth-surface-mapper-root', steps);
  },

  onStart(ctx) {
    ctx.emitMetric('workflow_runs_total', 1, 'counter', { workflowId, mission: 'auth_surface_mapper', stage: 'start' });
  },
  onFinish(ctx) {
    ctx.emitMetric('workflow_runs_total', 1, 'counter', { workflowId, mission: 'auth_surface_mapper', stage: 'finish' });
  },
  onError(ctx, error) {
    ctx.emitMetric('workflow_errors_total', 1, 'counter', { workflowId, mission: 'auth_surface_mapper', stage: 'error', error: error.name });
  },
};

export default authSurfaceMapperWorkflow;
