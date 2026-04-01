import {
  createWorkflow,
  type WorkflowExecutionContext,
  SequenceNodeBuilder,
} from '@jshookmcp/extension-sdk/workflow';

const workflowId = 'workflow.auth-surface-mapper.v1';

export default createWorkflow(workflowId, 'Auth Surface Mapper')
  .description(
    'Enumerates all authentication surfaces on a page: cookies, localStorage tokens, sessionStorage, authorization headers, JWT payloads, CSRF tokens, OAuth parameters, and API keys — producing a unified auth surface report with confidence scores.',
  )
  .tags(['reverse', 'auth', 'token', 'cookie', 'credential', 'jwt', 'csrf', 'mission'])
  .timeoutMs(6 * 60_000)
  .defaultMaxConcurrency(5)
  .buildGraph((ctx: WorkflowExecutionContext) => {
    const prefix = 'workflows.authSurfaceMapper';
    const url = String(ctx.getConfig(`${prefix}.url`, 'https://example.com'));
    const waitUntil = String(ctx.getConfig(`${prefix}.waitUntil`, 'networkidle0'));
    const requestTail = Number(ctx.getConfig(`${prefix}.requestTail`, 50));
    const minConfidence = Number(ctx.getConfig(`${prefix}.minConfidence`, 0.2));
    const maxConcurrency = Number(ctx.getConfig(`${prefix}.parallel.maxConcurrency`, 5));
    const triggerActions = Boolean(ctx.getConfig(`${prefix}.triggerActions`, false));

    const root = new SequenceNodeBuilder('auth-surface-mapper-root');

    // Phase 1: Network & Navigation
    root
      .tool('enable-network', 'network_enable', { input: { enableExceptions: true } })
      .tool('navigate', 'page_navigate', { input: { url, waitUntil } })

      // Phase 2: Parallel Surface Collection
      .parallel('collect-auth-surfaces', (p) => {
        p.maxConcurrency(maxConcurrency)
          .failFast(false)
          .tool('get-cookies', 'page_get_cookies')
          .tool('get-local-storage', 'page_get_local_storage')
          .tool('get-requests', 'network_get_requests', { input: { tail: requestTail } })
          .tool('extract-auth', 'network_extract_auth', { input: { minConfidence } })
          .tool('search-auth-patterns', 'search_in_scripts', {
            input: { query: 'authorization,bearer,jwt,token,csrf,x-csrf,api-key,apikey,secret', matchType: 'any' },
          })
          .tool('detect-crypto', 'detect_crypto', { input: {} });
      })

      // Phase 3: Token Deep Analysis
      .tool('evaluate-auth-state', 'page_evaluate', {
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
      });

    // Phase 4: Optional Login Trigger
    if (triggerActions) {
      root
        .tool('find-login-buttons', 'dom_find_clickable', { input: {} })
        .tool('get-forms', 'dom_query_all', { input: { selector: 'form[action]' } });
    }

    // Phase 5: Evidence Recording
    root
      .tool('create-evidence-session', 'instrumentation_session_create', {
        input: {
          name: `auth-surface-${new Date().toISOString().slice(0, 10)}`,
          metadata: { url, workflowId },
        },
      })
      .tool('record-artifact', 'instrumentation_artifact_record', {
        input: {
          type: 'auth_surface_report',
          label: `Auth surface analysis for ${url}`,
          metadata: { url, minConfidence, requestTail },
        },
      })

      // Phase 6: Session Insight
      .tool('emit-insight', 'append_session_insight', {
        input: {
          insight: JSON.stringify({
            status: 'auth_surface_mapper_complete',
            workflowId,
            url,
            minConfidence,
          }),
        },
      });

    return root;
  })
  .onStart((ctx) => {
    ctx.emitMetric('workflow_runs_total', 1, 'counter', { workflowId, mission: 'auth_surface_mapper', stage: 'start' });
  })
  .onFinish((ctx) => {
    ctx.emitMetric('workflow_runs_total', 1, 'counter', { workflowId, mission: 'auth_surface_mapper', stage: 'finish' });
  })
  .onError((ctx, error) => {
    ctx.emitMetric('workflow_errors_total', 1, 'counter', { workflowId, mission: 'auth_surface_mapper', stage: 'error', error: error.name });
  })
  .build();
