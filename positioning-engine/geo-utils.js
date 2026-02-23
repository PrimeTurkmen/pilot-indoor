/**
 * Geometry utilities for indoor positioning.
 * Ported from SiteTrack — zero dependencies, pure math.
 *
 * - haversineDistance: meters between two lat/lon points
 * - pointInPolygon: ray-casting for indoor x/y zone detection
 * - euclideanDistance: meters between two x/y points
 */

/**
 * Haversine distance between two lat/lon points in meters.
 * @param {number} lat1 @param {number} lon1
 * @param {number} lat2 @param {number} lon2
 * @returns {number} distance in meters
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Point-in-polygon test using ray casting algorithm.
 * Works for indoor x/y coordinates (meters or pixels).
 *
 * @param {[number, number]} point - [x, y]
 * @param {[number, number][]} polygon - array of [x, y] vertices
 * @returns {boolean} true if point is inside polygon
 */
function pointInPolygon(point, polygon) {
    const [px, py] = point;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * Euclidean distance between two 2D points (meters).
 * @param {number} x1 @param {number} y1
 * @param {number} x2 @param {number} y2
 * @returns {number}
 */
function euclideanDistance(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
}

module.exports = { haversineDistance, pointInPolygon, euclideanDistance };
