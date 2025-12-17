const { Builder, By, until } = require('selenium-webdriver');
const fs = require('fs');
const path = require('path');
const db = require('./db');

// BrowserStack configuration
const BROWSERSTACK_HUB_URL = 'https://hub-cloud.browserstack.com/wd/hub';

// Path to local browsers.json file
const BROWSERS_JSON_PATH = path.join(__dirname, 'browsers.json');

// Number of videos per batch
const BATCH_SIZE = 5;

// Wait timeout after clicking play (16 seconds as requested)
const VIDEO_PLAY_WAIT = 16000;

// Page load timeout
const PAGE_LOAD_WAIT = 15000;

/**
 * Load available mobile devices from local browsers.json file
 * Filters for real_mobile: true devices only
 * @returns {Array} Array of mobile devices
 */
function loadMobileDevices() {
    try {
        const content = fs.readFileSync(BROWSERS_JSON_PATH, 'utf8');
        const browsers = JSON.parse(content);

        // Filter for real mobile devices only (both Android and iOS)
        const mobileDevices = browsers.filter(b => b.real_mobile === true);

        // Remove duplicates based on device + os_version combination
        const uniqueDevices = [];
        const seen = new Set();

        for (const device of mobileDevices) {
            const key = `${device.device}-${device.os_version}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueDevices.push(device);
            }
        }

        console.log(`Loaded ${uniqueDevices.length} unique mobile devices from browsers.json`);
        return uniqueDevices;

    } catch (error) {
        console.error(`Failed to load browsers.json: ${error.message}`);
        // Fallback devices
        return [
            { device: 'Samsung Galaxy S21', os_version: '12.0', os: 'android', browser: 'chrome' },
            { device: 'Samsung Galaxy S22', os_version: '12.0', os: 'android', browser: 'chrome' },
            { device: 'Google Pixel 6', os_version: '12.0', os: 'android', browser: 'chrome' }
        ];
    }
}

/**
 * Get random device from available devices
 * @param {Array} devices - Array of available devices
 */
function getRandomDevice(devices) {
    const index = Math.floor(Math.random() * devices.length);
    return devices[index];
}

/**
 * Create BrowserStack capabilities for mobile device
 * @param {object} device - Device configuration from browsers.json
 */
function getBrowserStackCapabilities(device) {
    if (!process.env.BROWSERSTACK_USERNAME || !process.env.BROWSERSTACK_ACCESS_KEY) {
        throw new Error('BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY environment variables are required');
    }

    const deviceName = device.device;
    const osVersion = device.os_version;

    // Determine browser based on OS
    let browserName = 'chrome';
    if (device.os === 'ios') {
        browserName = 'safari';
    }

    return {
        'bstack:options': {
            'userName': process.env.BROWSERSTACK_USERNAME,
            'accessKey': process.env.BROWSERSTACK_ACCESS_KEY,
            'deviceName': deviceName,
            'osVersion': osVersion,
            'projectName': 'Video Test',
            'buildName': `Video Play Test - ${new Date().toISOString().split('T')[0]}`,
            'sessionName': `${deviceName} Session`,
            'debug': true,
            'networkLogs': true,
            'consoleLogs': 'info'
        },
        'browserName': browserName
    };
}

/**
 * Test video play functionality for a single URL
 * @param {object} driver - Selenium WebDriver instance
 * @param {object} videoRecord - Video record from database
 * @param {number} index - Test index for logging
 * @param {string} deviceName - Device name used
 * @returns {object} - Test result
 */
async function testVideoPlay(driver, videoRecord, index, deviceName) {
    const result = {
        id: videoRecord.id,
        url: videoRecord.url,
        success: false,
        error: null,
        playButtonFound: false,
        playButtonClicked: false
    };

    try {
        
        console.log(`    Current views: ${videoRecord.view_count}`);

        // Navigate to the video URL
        await driver.get(videoRecord.url);
        console.log(`    Page loaded`);

        // Wait for page to load
        await driver.sleep(3000);

        // Try to find the play button using multiple selectors
        const playButtonSelectors = [
            'div.videoPlayer_videoPlayer__rl3_b.videoPlayer_videoPlayIcon__6H_mJ',
            'div[class*="videoPlayIcon"]',
            'div[class*="videoPlayer_videoPlayIcon"]',
            'div[class*="videoPlayer"] img[alt=""]'
        ];

        let playButton = null;

        for (const selector of playButtonSelectors) {
            try {
                playButton = await driver.wait(
                    until.elementLocated(By.css(selector)),
                    5000
                );
                if (playButton) {
                    console.log(`    Play button found with selector: ${selector}`);
                    result.playButtonFound = true;
                    break;
                }
            } catch (e) {
                // Try next selector
            }
        }

        if (!playButton) {
            try {
                playButton = await driver.wait(
                    until.elementLocated(By.xpath('//div[contains(@class, "videoPlayIcon")]')),
                    5000
                );
                if (playButton) {
                    console.log(`    Play button found with XPath`);
                    result.playButtonFound = true;
                }
            } catch (e) {
                console.log(`    Play button not found`);
            }
        }

        if (playButton) {
            // Click the play button
            await playButton.click();
            console.log(`    Play button clicked`);
            result.playButtonClicked = true;

            // Wait for video to play (16 seconds as requested)
            console.log(`    Waiting ${VIDEO_PLAY_WAIT / 1000}s for video...`);
            await driver.sleep(VIDEO_PLAY_WAIT);

            result.success = true;
            console.log(`    ✅ Test PASSED`);

            // Update view count in database
            await db.updateViewCount(videoRecord.id, deviceName);
            console.log(`    View count updated in database`);

        } else {
            result.error = 'Play button not found';
            console.log(`    ❌ Test FAILED: Play button not found`);
            await db.markError(videoRecord.id, 'Play button not found');
        }

    } catch (error) {
        result.error = error.message;
        console.log(`    ❌ Test FAILED: ${error.message}`);
        await db.markError(videoRecord.id, error.message);
    }

    return result;
}

/**
 * Main test runner
 */
async function runTests() {
    console.log('========================================');
    console.log('BrowserStack Video Test');
    console.log('========================================\n');

    // Validate environment variables
    if (!process.env.DATABASE_URL) {
        console.error('ERROR: DATABASE_URL environment variable is required');
        process.exit(1);
    }

    if (!process.env.BROWSERSTACK_USERNAME || !process.env.BROWSERSTACK_ACCESS_KEY) {
        console.error('ERROR: BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY environment variables are required');
        process.exit(1);
    }

    // Load available devices from local browsers.json
    console.log('Loading devices from browsers.json...');
    const availableDevices = loadMobileDevices();
    console.log(`Total mobile devices available: ${availableDevices.length}`);

    // Initialize database
    console.log('\nInitializing database...');
    await db.initSchema();

    // Get next batch of videos
    console.log(`\nFetching next batch of ${BATCH_SIZE} videos...`);
    const videos = await db.getNextBatch(BATCH_SIZE);

    if (videos.length === 0) {
        console.log('No videos to test!');
        await db.close();
        process.exit(0);
    }

    console.log(`Found ${videos.length} videos to test`);

    // Select random device for this batch
    const device = getRandomDevice(availableDevices);
    const deviceName = device.device;
    const osVersion = device.os_version;
    const os = device.os;
    console.log(`\nSelected device: ${deviceName} (${os} ${osVersion})`);

    // Create WebDriver with BrowserStack capabilities
    console.log('Connecting to BrowserStack...');
    const capabilities = getBrowserStackCapabilities(device);

    let driver;
    try {
        driver = await new Builder()
            .usingServer(BROWSERSTACK_HUB_URL)
            .withCapabilities(capabilities)
            .build();

        console.log('Connected to BrowserStack successfully!');

    } catch (error) {
        console.error(`Failed to connect to BrowserStack: ${error.message}`);
        await db.close();
        process.exit(1);
    }

    // Run tests
    const results = [];

    try {
        for (let i = 0; i < videos.length; i++) {
            const result = await testVideoPlay(driver, videos[i], i + 1, deviceName);
            results.push(result);

            // Small delay between tests
            if (i < videos.length - 1) {
                await driver.sleep(1000);
            }
        }
    } finally {
        // Always quit the driver
        console.log('\nClosing BrowserStack session...');
        await driver.quit();
    }

    // Get and print stats
    const stats = await db.getStats();

    // Print summary
    console.log('\n========================================');
    console.log('Test Summary');
    console.log('========================================');

    const passed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`This batch: ${passed}/${results.length} passed`);
    console.log(`Device used: ${deviceName} (${os} ${osVersion})`);
    console.log(`\nDatabase Stats:`);
    console.log(`  Total URLs: ${stats.total}`);
    console.log(`  Total Views: ${stats.total_views || 0}`);
    console.log(`  Errors: ${stats.errors || 0}`);
    console.log(`  Avg Views/URL: ${parseFloat(stats.avg_views || 0).toFixed(2)}`);

    // Close database
    await db.close();

    // Exit with appropriate code
    process.exit(failed > 0 ? 1 : 0);
}

// Run the tests
runTests().catch(async error => {
    console.error('Unexpected error:', error);
    await db.close();
    process.exit(1);
});
