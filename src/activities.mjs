// Journey Builder custom activity config.json, rendered with the live base URL.
// sync  = custom split (RESTDECISION): the model's send/abstain picks the branch.
// async = fire-and-forget REST activity: model calls back via CDC (REST/S3).

const lifecycle = (base) => Object.fromEntries(
  ['save', 'publish', 'validate', 'stop'].map((op) => [op, { url: `${base}/${op}`, verb: 'POST', useJwt: true }]),
);

export function activityConfig(kind, baseUrl) {
  const base = `${baseUrl}/ca/${kind}`;
  const common = {
    workflowApiVersion: '1.1',
    metaData: { icon: 'icon.png', category: kind === 'sync' ? 'flow' : 'custom', isConfigured: false },
    configurationArguments: lifecycle(base),
    wizardSteps: [{ label: 'Configure', key: 'step1' }],
    userInterfaces: { configModal: { height: 520, width: 720, fullscreen: false } },
  };

  if (kind === 'sync') {
    return {
      ...common,
      type: 'RESTDECISION',
      lang: { 'en-US': { name: 'Expedia Saturation Check (Sync)', description: 'Calls the saturation model in real time and branches Send / Abstain.' } },
      arguments: {
        execute: {
          inArguments: [{ contactKey: '{{Contact.Key}}' }],
          outArguments: [],
          url: `${base}/execute`, verb: 'POST', format: 'json', useJwt: true,
          timeout: 10000, retryCount: 1, retryDelay: 1000, concurrentRequests: 5,
        },
      },
      outcomes: [
        { key: 'send', arguments: { branchResult: 'send' }, metaData: { label: 'Send' } },
        { key: 'abstain', arguments: { branchResult: 'abstain' }, metaData: { label: 'Abstain (saturated)' } },
      ],
      schema: {
        arguments: {
          execute: {
            inArguments: [{ contactKey: { dataType: 'Text', isNullable: false, direction: 'in' } }],
            outArguments: [
              { prediction: { dataType: 'Text', direction: 'out', access: 'visible' } },
              { saturationScore: { dataType: 'Decimal', direction: 'out', access: 'visible' } },
              { reasonCodes: { dataType: 'Text', direction: 'out', access: 'visible' } },
              { modelVersion: { dataType: 'Text', direction: 'out', access: 'visible' } },
            ],
          },
        },
      },
    };
  }

  return {
    ...common,
    type: 'REST',
    lang: { 'en-US': { name: 'Expedia Saturation Request (Async)', description: 'Fire-and-forget scoring request; model pushes the prediction back to contact data.' } },
    arguments: {
      execute: {
        inArguments: [{ contactKey: '{{Contact.Key}}' }, { delaySec: '8' }, { cdcMode: 'rest' }],
        outArguments: [],
        url: `${base}/execute`, verb: 'POST', format: 'json', useJwt: true,
        timeout: 5000, retryCount: 0, retryDelay: 1000, concurrentRequests: 10,
      },
    },
    schema: {
      arguments: {
        execute: {
          inArguments: [
            { contactKey: { dataType: 'Text', isNullable: false, direction: 'in' } },
            { delaySec: { dataType: 'Number', isNullable: true, direction: 'in' } },
            { cdcMode: { dataType: 'Text', isNullable: true, direction: 'in' } },
          ],
          outArguments: [],
        },
      },
    },
  };
}
