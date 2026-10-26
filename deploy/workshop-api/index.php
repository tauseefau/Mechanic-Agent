<?php
/**
 * Public bridge for the workshop voice agent API.
 *
 * Lives at /home/<user>/web/diyyourdata.com/public_html/workshop-api/index.php and is
 * reachable as https://diyyourdata.com/workshop-api/ .
 *
 * It is a dumb proxy on purpose: the business logic is the Apps Script modules in
 * apps-script/src, executed by the Node service on 127.0.0.1:8790 (server/serve.js).
 * A PHP proxy instead of an nginx location means Hestia can regenerate the vhost from
 * its templates without silently deleting the route.
 *
 * The shared token is NOT checked here — the backend checks body.token on every action,
 * so the same gate applies whether the call arrives via this bridge or directly.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const BACKEND = 'http://127.0.0.1:8790';
const TIMEOUT_SECONDS = 40;

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if (!in_array($method, ['GET', 'POST'], true)) {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'method_not_allowed']);
    exit;
}

// health check passthrough: /workshop-api/?health=1
if (isset($_GET['health'])) {
    $path = '/health';
    $payload = null;
} else {
    $path = '/';
    $payload = $method === 'POST' ? file_get_contents('php://input') : null;
}

$url = BACKEND . $path;
if ($method === 'GET' && !empty($_GET)) {
    $params = $_GET;
    unset($params['health']);
    if ($params) {
        $url .= '?' . http_build_query($params);
    }
}

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_CONNECTTIMEOUT => 3,
    CURLOPT_TIMEOUT        => TIMEOUT_SECONDS,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
]);
if ($payload !== null && $payload !== '') {
    curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
}

$response = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$error = curl_error($ch);
curl_close($ch);

if ($response === false) {
    http_response_code(502);
    echo json_encode([
        'success' => false,
        'error' => 'upstream_unreachable',
        'message' => 'The booking system is not responding. Please try again shortly.',
        'detail' => $error,
    ]);
    exit;
}

http_response_code($status ?: 502);
echo $response;
