const express = require('express');
const Airtable = require('airtable');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// Environment variables
const PORT = process.env.PORT || 3000;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;

// Initialize Airtable
const base = new Airtable({ apiKey: AIRTABLE_TOKEN }).base(AIRTABLE_BASE_ID);

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'online',
        service: 'Wan 2.2 Animate Generation',
        timestamp: new Date().toISOString()
    });
});

// Main animation generation endpoint
app.post('/generate-animation', async (req, res) => {
    const { recordId } = req.body;
    
    if (!recordId) {
        return res.status(400).json({ error: 'recordId is required' });
    }

    console.log('='.repeat(60));
    console.log('Starting animation generation for record:', recordId);
    console.log('Time:', new Date().toISOString());
    
    // Respond immediately to Airtable (prevent timeout)
    res.json({ 
        success: true, 
        message: 'Animation generation started',
        recordId: recordId
    });

    // Continue processing in background
    try {
        // Fetch record from Airtable
        console.log('Fetching record from Airtable...');
        const record = await base('animate_generation').find(recordId);
        
        const inputImage = record.fields.input_image?.[0]?.url;
        const inputVideo = record.fields.input_video?.[0]?.url;
        const prompt = record.fields.prompt || '';
        const mode = record.fields.mode || 'animate';
        const resolution = record.fields.resolution || '480p';
        const seed = record.fields.seed || -1;

        console.log('Input image:', inputImage ? 'Found' : 'Missing');
        console.log('Input video:', inputVideo ? 'Found' : 'Missing');
        console.log('Mode:', mode);
        console.log('Resolution:', resolution);

        // Validate required fields
        if (!inputImage) {
            throw new Error('No input image found');
        }
        if (!inputVideo) {
            throw new Error('No input video found');
        }

        // Update status
        await base('animate_generation').update(recordId, {
            status: 'Generating...',
            error_log: `Started at ${new Date().toISOString()}\nMode: ${mode}\nResolution: ${resolution}`
        });

        // Submit to Wavespeed API
        console.log('Submitting to Wavespeed API...');
        const submitPayload = {
            image: inputImage,
            video: inputVideo,
            mode: mode,
            resolution: resolution,
            seed: seed
        };

        // Only add prompt if provided
        if (prompt) {
            submitPayload.prompt = prompt;
        }

        const submitResponse = await fetch(
            'https://api.wavespeed.ai/api/v3/wavespeed-ai/wan-2.2/animate',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${WAVESPEED_API_KEY}`
                },
                body: JSON.stringify(submitPayload)
            }
        );

        const submitResult = await submitResponse.json();
        console.log('Submit response:', submitResult);

        if (!submitResponse.ok || submitResult.code !== 200) {
            throw new Error(`API error: ${submitResult.message || 'Unknown error'}`);
        }

        const jobId = submitResult.data.id;
        console.log('Job submitted successfully! Job ID:', jobId);

        // Update with job ID
        await base('animate_generation').update(recordId, {
            job_id: jobId,
            status: 'Processing...',
            error_log: `Job ID: ${jobId}\nSubmitted at ${new Date().toISOString()}`
        });

        // Poll for result
        const maxAttempts = 120; // 10 minutes max (5 seconds * 120)
        let attempt = 0;
        let completed = false;
        const startTime = Date.now();

        while (attempt < maxAttempts && !completed) {
            attempt++;
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds

            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            console.log(`Polling attempt ${attempt}/${maxAttempts} (${elapsed}s elapsed)...`);

            // Update status with time
            await base('animate_generation').update(recordId, {
                status: `Generating... ${elapsed}s elapsed`,
                error_log: `Job ID: ${jobId}\nProcessing... (attempt ${attempt}/${maxAttempts})`
            });

            const resultResponse = await fetch(
                `https://api.wavespeed.ai/api/v3/predictions/${jobId}/result`,
                {
                    headers: {
                        'Authorization': `Bearer ${WAVESPEED_API_KEY}`
                    }
                }
            );

            const result = await resultResponse.json();
            console.log('Current status:', result.data?.status);

            if (result.data?.status === 'completed') {
                completed = true;
                const videoUrl = result.data.outputs?.[0];
                
                if (!videoUrl) {
                    throw new Error('No video URL in completed response');
                }

                console.log('Animation completed! Video URL:', videoUrl);

                // Download video
                console.log('Downloading video...');
                const videoResponse = await fetch(videoUrl);
                const videoBuffer = await videoResponse.arrayBuffer();
                const base64Video = Buffer.from(videoBuffer).toString('base64');

                console.log('Uploading to Airtable...');
                await base('animate_generation').update(recordId, {
                    output_video: [{
                        url: videoUrl
                    }],
                    status: 'Completed',
                    error_log: `Completed at ${new Date().toISOString()}\nTotal time: ${elapsed}s\nVideo: ${videoUrl}`
                });

                console.log('SUCCESS! Animation uploaded to Airtable');
                console.log('='.repeat(60));

            } else if (result.data?.status === 'failed') {
                throw new Error(`Generation failed: ${result.data?.error || 'Unknown error'}`);
            }
        }

        if (!completed) {
            throw new Error('Timeout: Animation generation took too long');
        }

    } catch (error) {
        console.error('ERROR:', error.message);
        console.log('='.repeat(60));
        
        // Update Airtable with error
        try {
            await base('animate_generation').update(recordId, {
                status: 'Failed',
                error_log: `Error: ${error.message}\nTime: ${new Date().toISOString()}`
            });
        } catch (updateError) {
            console.error('Failed to update error in Airtable:', updateError);
        }
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Wan 2.2 Animate server running on port ${PORT}`);
    console.log('Endpoints:');
    console.log('  GET  / - Health check');
    console.log('  POST /generate-animation - Generate animation');
});
