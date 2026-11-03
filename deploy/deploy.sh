#!/bin/bash
# Idempotent AWS deploy: DynamoDB + S3 + IAM role + Lambda + API Gateway HTTP API.
# Secrets come from ~/expedia-mce.env and ~/.expedia-sat/ (never committed).
set -euo pipefail
cd "$(dirname "$0")/.."

REGION=${AWS_REGION:-us-east-1}
APP=expedia-sat-demo
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
TABLE=$APP
BUCKET=$APP-$ACCOUNT
ROLE=$APP-lambda
export AWS_REGION=$REGION

echo "== DynamoDB"
if ! aws dynamodb describe-table --table-name $TABLE >/dev/null 2>&1; then
  aws dynamodb create-table --table-name $TABLE --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE >/dev/null
  aws dynamodb wait table-exists --table-name $TABLE
  aws dynamodb update-time-to-live --table-name $TABLE --time-to-live-specification Enabled=true,AttributeName=ttl >/dev/null
fi

echo "== S3 ($BUCKET)"
if ! aws s3api head-bucket --bucket $BUCKET 2>/dev/null; then
  aws s3api create-bucket --bucket $BUCKET >/dev/null
  aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket $BUCKET --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
fi

echo "== IAM role"
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  aws iam create-role --role-name $ROLE --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10 # role propagation
fi
aws iam put-role-policy --role-name $ROLE --policy-name $APP-access --policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:PutItem","dynamodb:Query"],"Resource":"arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE"},
 {"Effect":"Allow","Action":["s3:PutObject"],"Resource":"arn:aws:s3:::$BUCKET/*"},
 {"Effect":"Allow","Action":["lambda:InvokeFunction"],"Resource":"arn:aws:lambda:$REGION:$ACCOUNT:function:$APP"}]}
JSON
)"

echo "== Package"
rm -f /tmp/$APP.zip && (cd src && zip -qr /tmp/$APP.zip . -x '.*')

echo "== Environment"
set -a; source ~/expedia-mce.env; set +a
ENV_FILE=$(mktemp)
python3 - "$ENV_FILE" <<PY
import json, os, sys
def d360_env():
    # Same trailsignup client-credentials app the data360 MCP uses.
    e = json.load(open(os.path.expanduser("~/.claude.json")))["mcpServers"]["data360"]["env"]
    return {"D360_LOGIN_URL": e["DATA360_LOGIN_URL"], "D360_CLIENT_ID": e["DATA360_CLIENT_ID"], "D360_CLIENT_SECRET": e["DATA360_CLIENT_SECRET"]}
v = {
  "TABLE_NAME": "$TABLE", "S3_BUCKET": "$BUCKET",
  "SEED_EMAIL": os.environ.get("SEED_EMAIL", "demo@example.com"),
  "MCE_CLIENT_ID": os.environ["MCE_CLIENT_ID"], "MCE_CLIENT_SECRET": os.environ["MCE_CLIENT_SECRET"],
  "MCE_AUTH_BASE_URL": os.environ["MCE_AUTH_BASE_URL"],
  "MCE_ACCOUNT_ID": os.environ.get("MCE_ACCOUNT_ID", ""),
  "MCE_EVENT_DEFINITION_KEY": os.environ.get("MCE_EVENT_DEFINITION_KEY", ""),
  "MCE_EVENT_DEFINITION_KEY_CD": "APIEvent-expedia-saturation-entry-cd",
  "MCE_PREDICTIONS_DE_KEY": "Expedia_Saturation_Predictions",
  "MCE_IMPORT_AUTOMATION_KEY": os.environ.get("MCE_IMPORT_AUTOMATION_KEY", ""),
  "MCE_JWT_SECRET": os.environ.get("MCE_JWT_SECRET", ""),
  "DBX_HOST": os.environ.get("DBX_HOST", ""), "DBX_WAREHOUSE_ID": os.environ.get("DBX_WAREHOUSE_ID", ""),
  "DBX_TOKEN": open(os.path.expanduser("~/.expedia-sat/dbx_pat")).read().strip(),
  **d360_env(),
}
json.dump({"Variables": v}, open(sys.argv[1], "w"))
PY

echo "== Lambda"
if ! aws lambda get-function --function-name $APP >/dev/null 2>&1; then
  aws lambda create-function --function-name $APP --runtime nodejs22.x --handler handler.handler \
    --role arn:aws:iam::$ACCOUNT:role/$ROLE --zip-file fileb:///tmp/$APP.zip \
    --timeout 90 --memory-size 512 --environment file://$ENV_FILE >/dev/null
  aws lambda wait function-active-v2 --function-name $APP
else
  aws lambda update-function-code --function-name $APP --zip-file fileb:///tmp/$APP.zip >/dev/null
  aws lambda wait function-updated-v2 --function-name $APP
  aws lambda update-function-configuration --function-name $APP --environment file://$ENV_FILE >/dev/null
  aws lambda wait function-updated-v2 --function-name $APP
fi
rm -f "$ENV_FILE"

echo "== API Gateway (HTTP API)"
# Org SCP denies public Lambda Function URLs, so front the Lambda with an HTTP API.
FN_ARN=arn:aws:lambda:$REGION:$ACCOUNT:function:$APP
API=$(aws apigatewayv2 get-apis --query "Items[?Name=='$APP'].ApiId | [0]" --output text)
if [ "$API" = "None" ] || [ -z "$API" ]; then
  API=$(aws apigatewayv2 create-api --name $APP --protocol-type HTTP --query ApiId --output text)
  INT=$(aws apigatewayv2 create-integration --api-id $API --integration-type AWS_PROXY --payload-format-version 2.0 \
    --integration-uri "arn:aws:apigateway:$REGION:lambda:path/2015-03-31/functions/$FN_ARN/invocations" \
    --timeout-in-millis 30000 --query IntegrationId --output text)
  aws apigatewayv2 create-route --api-id $API --route-key '$default' --target integrations/$INT >/dev/null
  aws apigatewayv2 create-stage --api-id $API --stage-name '$default' --auto-deploy >/dev/null
  aws lambda add-permission --function-name $APP --statement-id apigw-invoke --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API/*" >/dev/null
fi
URL=$(aws apigatewayv2 get-api --api-id $API --query ApiEndpoint --output text)
echo "$URL" > ~/.expedia-sat/url
echo "Deployed: $URL"
