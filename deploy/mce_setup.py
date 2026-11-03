"""Idempotent MCE setup for the saturation demo: folder + Data Extensions.
Usage: python3 mce_setup.py des
"""
import sys, html
import mce

FOLDER = "Expedia Saturation Model"

# (name, sendable, fields[(name, type, length/scale, pk, nullable)])
DES = {
    "Expedia_Traveler_Entry": dict(sendable=True, desc="API Event entry source for the saturation-aware journey", fields=[
        # One row per injection, so the same traveler can re-enter the journey.
        ("EntryId", "Text", 50, True, False),
        ("SubscriberKey", "Text", 50, False, False),
        ("EmailAddress", "EmailAddress", 254, False, False),
        ("FirstName", "Text", 50, False, True),
        ("LastName", "Text", 50, False, True),
        ("OneKeyTier", "Text", 20, False, True),
        ("HomeAirport", "Text", 5, False, True),
        ("Sends7d", "Number", None, False, True),
        ("Sends30d", "Number", None, False, True),
        ("OpenRate30d", "Decimal", (6, 4), False, True),
        ("ClickRate30d", "Decimal", (6, 4), False, True),
        ("DaysSinceLastEngaged", "Number", None, False, True),
        ("DaysToNextTrip", "Text", 10, False, True),
        ("EntryTimestamp", "Text", 40, False, True),
    ]),
}
# Entry DE for the "sync callout + contact data split" journey: same shape, its own API event.
DES["Expedia_Traveler_Entry_CD"] = dict(DES["Expedia_Traveler_Entry"], desc="API Event entry source for the sync-callout + contact-data-split journey")
DES = {**DES, **{
    "Expedia_Saturation_Predictions": dict(sendable=False, desc="Latest saturation prediction per traveler (CDC target from the model)", fields=[
        ("SubscriberKey", "Text", 50, True, False),
        ("SaturationScore", "Decimal", (6, 3), False, True),
        ("Prediction", "Text", 10, False, True),
        ("ReasonCodes", "Text", 255, False, True),
        ("RecommendedHoldHours", "Number", None, False, True),
        ("ModelVersion", "Text", 50, False, True),
        ("ScoringMode", "Text", 20, False, True),
        ("ScoredAt", "Text", 40, False, True),
        ("JourneyId", "Text", 100, False, True),
        ("ActivityId", "Text", 100, False, True),
    ]),
}}


def ensure_folder():
    rows, _ = mce.retrieve("DataFolder", ["ID", "Name", "ContentType", "ParentFolder.ID"], mce.simple_filter("ContentType", "equals", "dataextension"))
    for r in rows:
        if r["Name"] == FOLDER:
            return r["ID"]
    root = next(r["ID"] for r in rows if r["Name"] == "Data Extensions")
    xml = mce.soap("Create", f'''<CreateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI"><Objects xsi:type="DataFolder">
      <CustomerKey>expedia-saturation-model</CustomerKey><Name>{FOLDER}</Name><Description>Saturation model demo</Description>
      <ContentType>dataextension</ContentType><IsActive>true</IsActive><IsEditable>true</IsEditable><AllowChildren>true</AllowChildren>
      <ParentFolder><ID>{root}</ID></ParentFolder></Objects></CreateRequest>''')
    return _new_id(xml)


def _new_id(xml):
    import re
    if "<StatusCode>OK</StatusCode>" not in xml:
        raise RuntimeError(re.findall(r"<StatusMessage>(.*?)</StatusMessage>", xml) or xml[:800])
    return re.search(r"<NewID>(\d+)</NewID>", xml).group(1)


def field_xml(name, ftype, size, pk, nullable):
    parts = [f"<Name>{name}</Name><FieldType>{ftype}</FieldType>"]
    if ftype == "Decimal":
        parts.append(f"<MaxLength>{size[0]}</MaxLength><Scale>{size[1]}</Scale>")
    elif size:
        parts.append(f"<MaxLength>{size}</MaxLength>")
    parts.append(f"<IsPrimaryKey>{str(pk).lower()}</IsPrimaryKey><IsRequired>{str(not nullable).lower()}</IsRequired>")
    return "<Field>" + "".join(parts) + "</Field>"


def ensure_des(folder_id):
    existing = {r["CustomerKey"] for r in mce.retrieve("DataExtension", ["CustomerKey"])[0]}
    for name, spec in DES.items():
        if name in existing:
            print(f"  exists  {name}")
            continue
        send = ""
        if spec["sendable"]:
            send = ("<IsSendable>true</IsSendable><SendableDataExtensionField><Name>SubscriberKey</Name></SendableDataExtensionField>"
                    "<SendableSubscriberField><Name>Subscriber Key</Name></SendableSubscriberField>")
        xml = mce.soap("Create", f'''<CreateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI"><Objects xsi:type="DataExtension">
          <CategoryID>{folder_id}</CategoryID><CustomerKey>{name}</CustomerKey><Name>{name}</Name>
          <Description>{html.escape(spec["desc"])}</Description>{send}
          <Fields>{"".join(field_xml(*f) for f in spec["fields"])}</Fields></Objects></CreateRequest>''')
        _new_id(xml)
        print(f"  created {name}")


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "des"
    if step == "des":
        fid = ensure_folder()
        print("folder", fid)
        ensure_des(fid)
