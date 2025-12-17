/**
 * Database helper for video URLs management
 * Uses NeonDB PostgreSQL
 */

const { Pool } = require('pg');

// Database connection from environment variable
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

/**
 * Initialize database schema
 */
async function initSchema() {
    const client = await pool.connect();
    try {
        await client.query(`
      CREATE TABLE IF NOT EXISTS video_urls (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        user_name VARCHAR(255),
        post_id VARCHAR(255),
        caption TEXT,
        view_count INTEGER DEFAULT 0,
        last_played_at TIMESTAMP,
        status VARCHAR(50) DEFAULT 'pending',
        device_used VARCHAR(255),
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_video_urls_status ON video_urls(status);
      CREATE INDEX IF NOT EXISTS idx_video_urls_view_count ON video_urls(view_count);
    `);
        console.log('Database schema initialized');
    } finally {
        client.release();
    }
}

/**
 * Insert a video URL (ignore if exists)
 */
async function insertUrl(urlData) {
    const { url, userName, postId, caption } = urlData;
    const client = await pool.connect();
    try {
        await client.query(`
      INSERT INTO video_urls (url, user_name, post_id, caption)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (url) DO NOTHING
    `, [url, userName, postId, caption]);
    } finally {
        client.release();
    }
}

/**
 * Bulk insert URLs
 */
async function bulkInsertUrls(urls) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const urlData of urls) {
            await client.query(`
        INSERT INTO video_urls (url, user_name, post_id, caption)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (url) DO NOTHING
      `, [urlData.url, urlData.userName, urlData.postId, urlData.caption]);
        }

        await client.query('COMMIT');
        console.log(`Inserted ${urls.length} URLs`);
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Get next batch of URLs to play (prioritize by lowest view_count)
 * @param {number} limit - Number of URLs to fetch
 * @returns {Array} - Array of URL records
 */
async function getNextBatch(limit = 5) {
    const client = await pool.connect();
    try {
        const result = await client.query(`
      SELECT id, url, user_name, post_id, view_count
      FROM video_urls
      WHERE status != 'error'
      ORDER BY view_count ASC, last_played_at ASC NULLS FIRST
      LIMIT $1
    `, [limit]);
        return result.rows;
    } finally {
        client.release();
    }
}

/**
 * Update view count after successful play
 * @param {number} id - URL record ID
 * @param {string} deviceUsed - Device name used for this play
 */
async function updateViewCount(id, deviceUsed) {
    const client = await pool.connect();
    try {
        await client.query(`
      UPDATE video_urls
      SET view_count = view_count + 1,
          last_played_at = NOW(),
          status = 'completed',
          device_used = $2,
          updated_at = NOW()
      WHERE id = $1
    `, [id, deviceUsed]);
    } finally {
        client.release();
    }
}

/**
 * Mark URL as error
 * @param {number} id - URL record ID
 * @param {string} errorMessage - Error message
 */
async function markError(id, errorMessage) {
    const client = await pool.connect();
    try {
        await client.query(`
      UPDATE video_urls
      SET status = 'error',
          error_message = $2,
          updated_at = NOW()
      WHERE id = $1
    `, [id, errorMessage]);
    } finally {
        client.release();
    }
}

/**
 * Get statistics
 */
async function getStats() {
    const client = await pool.connect();
    try {
        const result = await client.query(`
      SELECT 
        COUNT(*) as total,
        SUM(view_count) as total_views,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as errors,
        AVG(view_count) as avg_views
      FROM video_urls
    `);
        return result.rows[0];
    } finally {
        client.release();
    }
}

/**
 * Close pool connection
 */
async function close() {
    await pool.end();
}

module.exports = {
    initSchema,
    insertUrl,
    bulkInsertUrls,
    getNextBatch,
    updateViewCount,
    markError,
    getStats,
    close
};
