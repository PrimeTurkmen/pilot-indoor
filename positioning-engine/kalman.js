/**
 * 2D Kalman filter for position smoothing.
 * State: [x, y, vx, vy]. Tuned for walking speed (~1.5 m/s).
 *
 * @see TECHNICAL_SPEC.md — kalman.js requirements
 */

/**
 * Create a Kalman filter instance for a single tag.
 *
 * @param {Object} opts
 * @param {number} [opts.dt=1] - Time step (seconds)
 * @param {number} [opts.processNoise=0.5] - Process noise (position)
 * @param {number} [opts.measurementNoise=1.0] - Measurement noise (Channel Sounding ~1m)
 */
function createKalmanFilter(opts = {}) {
    const dt = opts.dt || 1;
    const q = opts.processNoise ?? 0.5;
    const r = opts.measurementNoise ?? 1.0;

    // State: [x, y, vx, vy]
    let state = null;
    // Covariance 4x4
    let P = null;

    return {
        /**
         * Update with new measurement. Returns smoothed {x, y}.
         *
         * @param {number} x - Measured x
         * @param {number} y - Measured y
         * @returns {{x: number, y: number}}
         */
        update(x, y) {
            const z = [x, y];

            if (state === null) {
                state = [x, y, 0, 0];
                P = [
                    [r, 0, 0, 0],
                    [0, r, 0, 0],
                    [0, 0, 10, 0],
                    [0, 0, 0, 10]
                ];
                return { x, y };
            }

            // F: state transition
            const F = [
                [1, 0, dt, 0],
                [0, 1, 0, dt],
                [0, 0, 1, 0],
                [0, 0, 0, 1]
            ];
            // H: observation (we observe x, y only)
            const H = [[1, 0, 0, 0], [0, 1, 0, 0]];
            // Q: process noise
            const Q = [
                [q * dt * dt * dt * dt / 4, 0, q * dt * dt * dt / 2, 0],
                [0, q * dt * dt * dt * dt / 4, 0, q * dt * dt * dt / 2],
                [q * dt * dt * dt / 2, 0, q * dt * dt, 0],
                [0, q * dt * dt * dt / 2, 0, q * dt * dt]
            ];
            const R = [[r * r, 0], [0, r * r]];

            // Predict
            const x_pred = [
                state[0] + state[2] * dt,
                state[1] + state[3] * dt,
                state[2],
                state[3]
            ];
            const P_pred = add(multiply4(F, P, transpose4(F)), Q);

            // Update
            const Ht = transpose2(H);
            const S = add(multiply(H, multiply4(P_pred, Ht)), R);
            const Si = inv2(S);
            const K = multiply4(multiply4(P_pred, Ht), Si);
            const innov = [z[0] - x_pred[0], z[1] - x_pred[1]];
            const Ky = [K[0][0] * innov[0] + K[0][1] * innov[1], K[1][0] * innov[0] + K[1][1] * innov[1], K[2][0] * innov[0] + K[2][1] * innov[1], K[3][0] * innov[0] + K[3][1] * innov[1]];
            state = [x_pred[0] + Ky[0], x_pred[1] + Ky[1], x_pred[2] + Ky[2], x_pred[3] + Ky[3]];
            const IKH = sub4(eye4(), multiply4(K, H));
            P = multiply4(IKH, multiply4(P_pred, transpose4(IKH)));

            return { x: state[0], y: state[1] };
        },

        getState() {
            return state ? { x: state[0], y: state[1], vx: state[2], vy: state[3] } : null;
        },

        reset() {
            state = null;
            P = null;
        }
    };
}

function multiply4(A, B) {
    const C = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++)
            for (let k = 0; k < 4; k++)
                C[i][j] += A[i][k] * B[k][j];
    return C;
}

function multiply(A, B) {
    const rows = A.length, cols = B[0].length, inner = B.length;
    const C = Array(rows).fill(0).map(() => Array(cols).fill(0));
    for (let i = 0; i < rows; i++)
        for (let j = 0; j < cols; j++)
            for (let k = 0; k < inner; k++)
                C[i][j] += A[i][k] * B[k][j];
    return C;
}

function transpose4(M) {
    return [[M[0][0], M[1][0], M[2][0], M[3][0]], [M[0][1], M[1][1], M[2][1], M[3][1]], [M[0][2], M[1][2], M[2][2], M[3][2]], [M[0][3], M[1][3], M[2][3], M[3][3]]];
}

function transpose2(M) {
    return [[M[0][0], M[1][0]], [M[0][1], M[1][1]]];
}

function add(A, B) {
    return A.map((row, i) => row.map((v, j) => v + B[i][j]));
}

function sub4(A, B) {
    return A.map((row, i) => row.map((v, j) => v - B[i][j]));
}

function eye4() {
    return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
}

function inv2(M) {
    const det = M[0][0] * M[1][1] - M[0][1] * M[1][0];
    if (Math.abs(det) < 1e-10) return [[1, 0], [0, 1]];
    return [[M[1][1] / det, -M[0][1] / det], [-M[1][0] / det, M[0][0] / det]];
}

module.exports = { createKalmanFilter };
