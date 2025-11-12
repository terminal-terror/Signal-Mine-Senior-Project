<?php
/**
 * chat.php — PHP proxy for the chat UI
 * - Uses LOCAL variables first (below) so you can pin an intake URL like /invoke/chat
 * - Falls back to values from config.php if locals are blank
 * - Accepts JSON from the browser: { prompt, conversation_id?, base?, token?, intake? }
 * - Forwards to BACKEND_BASE + INTAKE_PATH
 * - Passes through JSON or SSE (text/event-stream) responses
 */

ignore_user_abort(true);
set_time_limit(0);

/* ---------- CORS / preflight ---------- */
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: POST, OPTIONS');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  http_response_code(204);
  exit;
}

/* ---------- Read request body ---------- */
$raw = file_get_contents('php://input');
$in  = json_decode($raw, true) ?: [];

$prompt          = $in['prompt'] ?? '';
$conversation_id = $in['conversation_id'] ?? null;

// Optional per-request overrides (allowed but NOT required)
$incomingBase   = isset($in['base'])   ? trim((string)$in['base'])   : '';
$incomingToken  = isset($in['token'])  ? trim((string)$in['token'])  : '';
$incomingIntake = isset($in['intake']) ? trim((string)$in['intake']) : '';

if (!$prompt) {
  header('Content-Type: application/json');
  http_response_code(400);
  echo json_encode(['error' => 'Missing prompt']);
  exit;
}

/* ---------- LOCAL OVERRIDES (edit these) ---------- */
/* Set these to pin your local intake; leave blank to let config.php or request provide values. */
$LOCAL_BACKEND_BASE = 'http://localhost:8000/api';   // e.g., FastAPI root
$LOCAL_INTAKE_PATH  = '/invoke/chat';                // <- your intake endpoint
$LOCAL_BEARER_TOKEN = '';                            // optional token

/* ---------- Load config fallback ---------- */
$cfg = require __DIR__ . '/config.php';
$cfgBase  = isset($cfg['BACKEND_BASE']) ? trim((string)$cfg['BACKEND_BASE']) : '';
$cfgToken = isset($cfg['BEARER_TOKEN']) ? trim((string)$cfg['BEARER_TOKEN']) : '';

/* ---------- Resolve final connection values (precedence: LOCAL > request > config) ---------- */
$backendBase = $LOCAL_BACKEND_BASE !== '' ? $LOCAL_BACKEND_BASE
              : ($incomingBase !== ''     ? $incomingBase     : $cfgBase);

$intakePath  = $LOCAL_INTAKE_PATH  !== '' ? $LOCAL_INTAKE_PATH
              : ($incomingIntake !== ''   ? $incomingIntake   : '/invoke/chat'); // default

$bearerToken = $LOCAL_BEARER_TOKEN !== '' ? $LOCAL_BEARER_TOKEN
              : ($incomingToken !== ''     ? $incomingToken     : $cfgToken);

/* Normalize and build endpoint */
$endpoint = rtrim($backendBase, '/') . (strpos($intakePath, '/') === 0 ? $intakePath : ('/' . $intakePath));

/* ---------- Prepare outbound request ---------- */
$payload = json_encode(array_filter([
  'prompt'          => $prompt,
  'conversation_id' => $conversation_id
], fn($v) => $v !== null && $v !== ''));

$headers = ['Content-Type: application/json'];
if ($bearerToken !== '') {
  $headers[] = 'Authorization: Bearer ' . $bearerToken;
}

/* ---------- Execute request with streaming passthrough ---------- */
$ch = curl_init($endpoint);
curl_setopt_array($ch, [
  CURLOPT_POST           => true,
  CURLOPT_HTTPHEADER     => $headers,
  CURLOPT_POSTFIELDS     => $payload,
  CURLOPT_RETURNTRANSFER => false,   // stream
  CURLOPT_HEADER         => true,
  CURLOPT_WRITEFUNCTION  => function($ch, $chunk) {
    static $headerDone = false;

    // First pass includes headers + maybe some body
    if (!$headerDone) {
      $pos = strpos($chunk, "\r\n\r\n");
      if ($pos !== false) {
        $rawHeaders = substr($chunk, 0, $pos);
        $body       = substr($chunk, $pos + 4);

        // Detect backend content type
        if (stripos($rawHeaders, 'Content-Type: text/event-stream') !== false) {
          header('Content-Type: text/event-stream');
          header('Cache-Control: no-cache');
          header('X-Accel-Buffering: no'); // nginx: disable buffering for SSE
          @ob_end_flush(); @flush();
        } else {
          header('Content-Type: application/json; charset=utf-8');
        }

        // Forward any body that arrived with headers
        if ($body !== '') {
          echo $body;
          @ob_flush(); @flush();
        }

        $headerDone = true;
      }
      // Always report bytes consumed
      return strlen($chunk);
    }

    // Subsequent chunks are body; forward directly (supports SSE)
    echo $chunk;
    @ob_flush(); @flush();
    return strlen($chunk);
  },
]);

curl_exec($ch);

/* ---------- Error handling ---------- */
if (curl_errno($ch)) {
  if (!headers_sent()) {
    header('Content-Type: application/json; charset=utf-8');
  }
  echo json_encode([
    'error' => 'Proxy error',
    'detail' => curl_error($ch),
    'endpoint' => $endpoint,
  ]);
}

curl_close($ch);
