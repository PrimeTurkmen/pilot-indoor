/**
 * Weighted Least Squares trilateration from 3+ distance measurements.
 * Uses mathjs for linear algebra. Returns {x, y, confidence}.
 *
 * @see TECHNICAL_SPEC.md — trilateration.js requirements
 */

const math = require('mathjs');

/**
 * Solve trilateration: find (x, y) given anchor positions and distances.
 * Weighted by measurement quality (0–1).
 *
 * @param {Array<{x: number, y: number, z?: number, distance_m: number, quality?: number}>} measurements
 * @returns {{x: number, y: number, confidence: number} | null}
 */
function trilaterate(measurements) {
    if (!measurements || measurements.length < 3) {
        return null;
    }

    // Filter valid measurements
    const valid = measurements.filter(
        m => typeof m.x === 'number' && typeof m.y === 'number' &&
             typeof m.distance_m === 'number' && m.distance_m > 0 && m.distance_m < 100
    );
    if (valid.length < 3) return null;

    // Quality weight (default 0.9 if missing)
    const weights = valid.map(m => Math.min(1, Math.max(0.1, m.quality || 0.9)));

    // Linearized system: 2*(x_i - x_1)*x + 2*(y_i - y_1)*y = d_1^2 - d_i^2 + x_i^2 - x_1^2 + y_i^2 - y_1^2
    const x1 = valid[0].x, y1 = valid[0].y, d1 = valid[0].distance_m;

    const A = [];
    const b = [];
    for (let i = 1; i < valid.length; i++) {
        const xi = valid[i].x, yi = valid[i].y, di = valid[i].distance_m;
        const w = Math.sqrt(weights[0] * weights[i]);
        A.push([2 * (xi - x1) * w, 2 * (yi - y1) * w]);
        const bi = d1 * d1 - di * di + xi * xi - x1 * x1 + yi * yi - y1 * y1;
        b.push([bi * w]);
    }

    try {
        const Am = math.matrix(A);
        const bm = math.matrix(b);
        const AtA = math.multiply(math.transpose(Am), Am);
        const Atb = math.multiply(math.transpose(Am), bm);
        const AtAinv = math.inv(AtA);
        const sol = math.multiply(AtAinv, Atb);
        const x = sol.get([0, 0]);
        const y = sol.get([1, 0]);

        // Confidence: inverse of residual
        let residual = 0;
        for (let i = 0; i < valid.length; i++) {
            const xi = valid[i].x, yi = valid[i].y, di = valid[i].distance_m;
            const est = Math.sqrt((x - xi) ** 2 + (y - yi) ** 2);
            residual += (di - est) ** 2;
        }
        const confidence = Math.max(0, Math.min(1, 1 - Math.sqrt(residual / valid.length) / 5));

        return { x, y, confidence };
    } catch (e) {
        return null;
    }
}

module.exports = { trilaterate };
