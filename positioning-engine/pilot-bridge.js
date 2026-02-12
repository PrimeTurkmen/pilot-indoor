/**
 * Converts local X,Y coordinates to lat/lon using floor plan calibration.
 * Affine transformation from 3 reference points. Posts to Pilot API V3.
 *
 * @see TECHNICAL_SPEC.md — pilot-bridge.js requirements
 */

const fetch = require('node-fetch');

/**
 * Build affine transform matrix from 3 calibration points.
 * Maps pixel [x, y] -> geo [lat, lon].
 * Uses least-squares fit: [lat, lon] = A * [x, y, 1]
 *
 * @param {Array<{pixel: [number, number], geo: [number, number]}>} points
 * @returns {number[][]} 2x3 matrix A
 */
function buildAffineTransform(points) {
    if (!points || points.length < 3) return null;

    // [x, y, 1] * A^T = [lat, lon]
    const n = points.length;
    const X = points.map(p => [p.pixel[0], p.pixel[1], 1]);
    const Y = points.map(p => p.geo);

    // Y = X * B  =>  B = (X'X)^-1 X' Y
    const Xt = transpose(X);
    const XtX = matMul(Xt, X);
    const XtXinv = inv3(XtX);
    if (!XtXinv) return null;
    const XtY = matMul(Xt, Y);
    const B = matMul(XtXinv, XtY);

    return transpose(B); // 2x3: [[a,b,c],[d,e,f]] for lat=a*x+b*y+c, lon=d*x+e*y+f
}

function pixelToGeo(transform, x, y) {
    if (!transform || transform.length !== 2) return null;
    const lat = transform[0][0] * x + transform[0][1] * y + transform[0][2];
    const lon = transform[1][0] * x + transform[1][1] * y + transform[1][2];
    return { lat, lon };
}

function transpose(M) {
    return M[0].map((_, j) => M.map(row => row[j]));
}

function matMul(A, B) {
    const C = A.map(row => Array(B[0].length).fill(0));
    for (let i = 0; i < A.length; i++)
        for (let j = 0; j < B[0].length; j++)
            for (let k = 0; k < A[0].length; k++)
                C[i][j] += A[i][k] * B[k][j];
    return C;
}

function inv3(M) {
    if (M.length !== 3 || M[0].length !== 3) return null;
    const a = M[0][0], b = M[0][1], c = M[0][2];
    const d = M[1][0], e = M[1][1], f = M[1][2];
    const g = M[2][0], h = M[2][1], i = M[2][2];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return null;
    return [
        [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
        [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]
    ];
}

/**
 * Post position update to Pilot API V3.
 *
 * @param {Object} opts
 * @param {string} opts.apiUrl - Base URL (e.g. https://server.pilot-gps.com)
 * @param {string} opts.apiKey - API key
 * @param {string} opts.unitId - Unit/device ID
 * @param {number} opts.lat
 * @param {number} opts.lon
 * @param {number} [opts.speed]
 * @param {number} [opts.timestamp] - Unix seconds
 */
async function postPosition(opts) {
    const { apiUrl, apiKey, unitId, lat, lon, speed, timestamp } = opts;
    const url = `${apiUrl.replace(/\/$/, '')}/api/v3/units/${unitId}/position`;
    const body = {
        lat,
        lon,
        ...(speed != null && { speed }),
        ...(timestamp != null && { timestamp })
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'X-API-Key': apiKey
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        throw new Error(`Pilot API error ${res.status}: ${await res.text()}`);
    }
    return res.json();
}

module.exports = {
    buildAffineTransform,
    pixelToGeo,
    postPosition
};
