"""Create (or recreate the draft of) the saturation-aware journey via the Interaction API.
Entry (API Event) -> Sync saturation split -> [Send | Abstain] -> Async request -> Wait 1 min.
Email + contact-data decision split are added later in the UI.
"""
import json, os, sys, urllib.request
import mce

NAME = "Expedia Saturation-Aware Trip Inspiration"
EVENT_KEY = mce.ENV["MCE_EVENT_DEFINITION_KEY"]
BASE = open(os.path.expanduser("~/.expedia-sat/url")).read().strip()


def ca_config(kind):
    with urllib.request.urlopen(f"{BASE}/ca/{kind}/config.json") as r:
        return json.load(r)


def custom_activity(kind, key, ext_key, outcomes):
    cfg = ca_config(kind)
    cfg_args = dict(cfg["configurationArguments"], applicationExtensionKey=ext_key)
    a = {
        "key": key, "name": cfg["lang"]["en-US"]["name"], "type": cfg["type"],
        "arguments": cfg["arguments"], "configurationArguments": cfg_args,
        "metaData": dict(cfg["metaData"], isConfigured=True, icon=f"{BASE}/ca/{kind}/icon.png", iconSmall=f"{BASE}/ca/{kind}/icon.png"),
        "schema": cfg.get("schema", {}), "outcomes": outcomes,
    }
    return a


def wait(key, minutes=1):
    return {
        "key": key, "name": f"{minutes} minute", "type": "WAIT",
        "outcomes": [{"key": f"{key}-out", "arguments": {}, "metaData": {"invalid": False}}],
        "configurationArguments": {"waitDuration": minutes, "waitUnit": "MINUTES"},
        "metaData": {"isConfigured": True, "waitType": "duration", "uiType": "WAITBYDURATION"},
    }


def build():
    ev = mce.rest("GET", f"/interaction/v1/eventDefinitions/key:{EVENT_KEY}")
    sync = custom_activity("sync", "SAT-SYNC", mce.ENV["MCE_CA_SYNC_KEY"], [
        {"key": "send", "next": "SAT-ASYNC-SEND", "arguments": {"branchResult": "send"}, "metaData": {"label": "Send"}},
        {"key": "abstain", "next": "SAT-ASYNC-ABSTAIN", "arguments": {"branchResult": "abstain"}, "metaData": {"label": "Abstain (saturated)"}},
    ])
    acts = [sync]
    for branch in ("SEND", "ABSTAIN"):
        acts.append(custom_activity("async", f"SAT-ASYNC-{branch}", mce.ENV["MCE_CA_ASYNC_KEY"],
                                    [{"key": f"SAT-ASYNC-{branch}-out", "next": f"WAIT-{branch}", "arguments": {}, "metaData": {}}]))
        acts.append(wait(f"WAIT-{branch}"))
    return {
        "key": "expedia-saturation-aware-journey",
        "name": NAME,
        "description": "Demo: sync custom split + async CDC scoring by the Expedia saturation model",
        "workflowApiVersion": 1.0,
        "defaults": {"email": ["{{Event." + EVENT_KEY + ".EmailAddress}}"]},
        "triggers": [{
            "key": "TRIGGER", "name": "Expedia Traveler Entry", "type": "APIEvent",
            "arguments": {"startActivityKey": "{{Context.StartActivityKey}}", "dequeueReason": "{{Context.DequeueReason}}", "lastExecutedActivityKey": "{{Context.LastExecutedActivityKey}}", "filterResult": "true"},
            "configurationArguments": {"schemaVersionId": 0, "criteria": "", "filterDefinitionId": "00000000-0000-0000-0000-000000000000"},
            "metaData": {"eventDefinitionId": ev["id"], "eventDefinitionKey": EVENT_KEY, "chainType": "None", "configurationRequired": False,
                         "iconUrl": "/images/icon_journeyBuilder-event-api-blue.svg", "category": "Event",
                         "entrySourceGroupConfigUrl": "jb:///data/entry/api-event/entrysourcegroupconfig.json"},
        }],
        "entryMode": "MultipleEntries",
        "activities": acts,
    }


if __name__ == "__main__":
    existing = mce.rest("GET", "/interaction/v1/interactions/key:expedia-saturation-aware-journey") if "--update" in sys.argv else None
    body = build()
    if existing:
        body.update(id=existing["id"], version=existing["version"])
        r = mce.rest("PUT", "/interaction/v1/interactions", body)
    else:
        r = mce.rest("POST", "/interaction/v1/interactions", body)
    print(json.dumps({k: r.get(k) for k in ("id", "key", "name", "version", "status")}))
