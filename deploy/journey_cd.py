"""Journey 2: sync callout only, then a Contact Data decision split.
Entry (API Event) -> Sync callout (model scores + writes Expedia_Saturation_Predictions before replying)
  -> Decision split on Contact Data: Saturation Prediction.Prediction = send / abstain / no score -> Wait.
No emails yet: each branch ends in a wait placeholder.
Usage: python3 journey_cd.py [--update]
"""
import json, sys
import mce
from journey import custom_activity, wait

KEY = "expedia-saturation-sync-contactdata"
NAME = "Expedia Saturation: Sync Callout + Contact Data Split"
EVENT_KEY = "APIEvent-expedia-saturation-entry-cd"
DE = "Expedia_Saturation_Predictions"


def condition(field, value):
    # Contact Data path: Attribute Group "Saturation Prediction" -> DE Expedia_Saturation_Predictions.
    return (f'<FilterDefinition><ConditionSet Operator="AND" ConditionSetName="Individual Filter Grouping">'
            f'<Condition Key="{DE}.{field}" Operator="Equal" UiMetaData="{{}}"><Value><![CDATA[{value}]]></Value></Condition>'
            f'</ConditionSet></FilterDefinition>')


def split():
    return {
        "key": "CD-SPLIT", "name": "Contact Data: model prediction", "type": "MULTICRITERIADECISION",
        "outcomes": [
            {"key": "path_send", "next": "WAIT-SEND", "arguments": {}, "metaData": {"label": "Send", "skipI18n": True, "criteriaDescription": "Prediction equal send", "invalid": False}},
            {"key": "path_abstain", "next": "WAIT-ABSTAIN", "arguments": {}, "metaData": {"label": "Abstain (saturated)", "skipI18n": True, "criteriaDescription": "Prediction equal abstain", "invalid": False}},
            {"key": "remainder_path", "next": "WAIT-NOSCORE", "arguments": {}, "metaData": {"label": "No score", "skipI18n": True, "invalid": False}},
        ],
        "arguments": {},
        "configurationArguments": {"criteria": {"path_send": condition("Prediction", "send"), "path_abstain": condition("Prediction", "abstain")}},
        "metaData": {"isConfigured": True},
    }


def labelled_waits():
    # Placeholders until emails are added: the name shows which path a contact took in journey history.
    out = []
    for key, name in (("WAIT-SEND", "Send path (email goes here)"), ("WAIT-ABSTAIN", "Abstain path (hold)"), ("WAIT-NOSCORE", "No score path")):
        w = wait(key)
        w["name"] = name
        out.append(w)
    return out


def build():
    ev = mce.rest("GET", f"/interaction/v1/eventDefinitions/key:{EVENT_KEY}")
    callout = custom_activity("sync", "SAT-CALLOUT", mce.ENV["MCE_CA_SYNC_KEY"], [
        {"key": "written", "next": "CD-SPLIT", "arguments": {"branchResult": "written"}, "metaData": {"label": "Prediction written to contact data"}},
    ])
    callout["name"] = "Saturation Callout (Sync, writes Contact Data)"
    callout["arguments"]["execute"]["inArguments"] = [{"contactKey": "{{Contact.Key}}"}, {"mode": "callout"}]
    return {
        "key": KEY, "name": NAME,
        "description": "Demo: one outbound sync callout; the model writes its answer to contact data and a decision split reads it",
        "workflowApiVersion": 1.0,
        "defaults": {"email": ["{{Event." + EVENT_KEY + ".EmailAddress}}"]},
        "triggers": [{
            "key": "TRIGGER", "name": "Expedia Traveler Entry (Contact Data split)", "type": "APIEvent",
            "arguments": {"startActivityKey": "{{Context.StartActivityKey}}", "dequeueReason": "{{Context.DequeueReason}}", "lastExecutedActivityKey": "{{Context.LastExecutedActivityKey}}", "filterResult": "true"},
            "configurationArguments": {"schemaVersionId": 0, "criteria": "", "filterDefinitionId": "00000000-0000-0000-0000-000000000000"},
            "metaData": {"eventDefinitionId": ev["id"], "eventDefinitionKey": EVENT_KEY, "chainType": "None", "configurationRequired": False,
                         "iconUrl": "/images/icon_journeyBuilder-event-api-blue.svg", "category": "Event",
                         "entrySourceGroupConfigUrl": "jb:///data/entry/api-event/entrysourcegroupconfig.json"},
        }],
        "entryMode": "MultipleEntries",
        "activities": [callout, split(), *labelled_waits()],
    }


if __name__ == "__main__":
    existing = mce.rest("GET", f"/interaction/v1/interactions/key:{KEY}") if "--update" in sys.argv else None
    body = build()
    if existing:
        body.update(id=existing["id"], version=existing["version"])
        r = mce.rest("PUT", "/interaction/v1/interactions", body)
    else:
        r = mce.rest("POST", "/interaction/v1/interactions", body)
    print(json.dumps({k: r.get(k) for k in ("id", "key", "name", "version", "status")}))
