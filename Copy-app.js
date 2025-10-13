import express from 'express';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai'; // No Type needed
import fs from 'fs';
import csvParser from 'csv-parser';

dotenv.config();

const app = express();
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Route for general chat (unchanged)
app.get('/gemini', async (req, res) => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          parts: [
            { text: "How are you" }
          ]
        }
      ]
    });
    res.json({ text: response.text });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Define a route to trigger the analysis of the local CSV file
app.get('/analyze-india-csv', async (req, res) => {
  try {
    // 1. Read and parse the CSV file
    const csvFilePath = './India.csv';
    if (!fs.existsSync(csvFilePath)) {
      return res.status(404).json({ error: 'India.csv file not found.' });
    }

    const rows = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(csvFilePath)
        .pipe(csvParser())
        .on('data', (row) => rows.push(row))
        .on('end', resolve)
        .on('error', reject);
    });

    if (rows.length === 0) {
      return res.status(400).json({ error: 'CSV file is empty.' });
    }

    // 2. Sample rows to fit token limit (aim for ~1M tokens total input)
    const maxRows = 1000; // Adjust based on row complexity; ~500-1500 should fit for most CSVs
    const sampleRows = rows.slice(0, maxRows);
    const headers = Object.keys(sampleRows[0] || {});

    // Reconstruct compact CSV string: headers + sampled data (no fancy formatting)
    let compactCsv = `Headers: ${headers.join(',')}\n\nSample Data (${sampleRows.length} of ${rows.length} rows sampled for analysis):\n`;
    sampleRows.forEach(row => {
      compactCsv += `${Object.values(row).map(val => `"${val}"`).join(',')}\n`;
    });
    compactCsv += `\n\nFull dataset has ${rows.length} rows. Extrapolate trends from this sample.`;

    // Rough token estimate: chars / 4 (overestimates slightly for safety)
    const estimatedTokens = Math.ceil(compactCsv.length / 4) + 500; // + buffer for prompt overhead
    const MAX_TOKENS = 2000000; // Gemini 2.5 limit
    if (estimatedTokens > MAX_TOKENS) {
      return res.status(400).json({ 
        error: `CSV too large (${estimatedTokens} estimated tokens). Sample only ${Math.floor((MAX_TOKENS * 4) / Object.keys(sampleRows[0]).length / 10)} rows or use a smaller file.` 
      });
    }

    console.log(`Using ${sampleRows.length} rows; estimated tokens: ${estimatedTokens}`);

    // 3. Prepare the prompt with the compact CSV data
    const prompt = [
      {
        parts: [
          {
            text: `Here is sampled data from India.csv (full size: ${rows.length} rows):\n\n${compactCsv}\n\n` +
                  `Analyze this data and return the analysis STRICTLY in the JSON schema provided—no extra text, explanations, or markdown. ` +
                  `Include a 'summary' of key findings, ` +
                  `a 'statistics' object with metrics like average or total for relevant columns (use sample data; e.g., include avg_value, total_count, and any column-specific like gdp_avg), ` +
                  `and an 'insights' array highlighting any notable trends or observations. ` +
                  `Extrapolate to the full dataset where possible.`
          }
        ]
      }
    ];

    // Define the schema to enforce valid JSON (now with non-empty properties for statistics)
    const responseSchema = {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'High-level summary of key findings from the data.'
        },
        statistics: {
          type: 'object',
          properties: {
            avg_value: {
              type: 'number',
              description: 'Example average value from a key numeric column in the sample.'
            },
            total_count: {
              type: 'number',
              description: 'Total count or sum for a relevant column in the sample.'
            }
            // Add more if needed; additionalProperties: true below allows extras
          },
          description: 'Metrics like averages or totals for relevant columns from the sample.',
          additionalProperties: true  // Allows dynamic keys (e.g., {"population_avg": 85000000})
        },
        insights: {
          type: 'array',
          items: {
            type: 'string',
            description: 'Notable trends or observations.'
          }
        }
      },
      required: ['summary', 'statistics', 'insights'],
      additionalProperties: false  // Prevent extra top-level keys
    };

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema,  // Now valid—no empty properties!
        thinkingBudget: 0,
        temperature: 0  // Max consistency
      },
    });

    // 4. Parse the JSON response
    const responseText = result.text;
    console.log('Raw response from Gemini:', responseText);  // Debug log

    if (!responseText) {
      return res.status(500).json({
        error: 'Gemini returned empty response.',
        result: JSON.stringify(result, null, 2)
      });
    }

    let analysis;
    try {
      analysis = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse JSON response:', responseText);
      return res.status(500).json({
        error: 'Gemini returned invalid JSON format.',
        geminiResponse: responseText,
        parseError: parseError.message
      });
    }

    // 5. Send the JSON analysis back to the client
    analysis.metadata = { fullRows: rows.length, sampledRows: sampleRows.length, estimatedTokens };
    res.json(analysis);

  } catch (error) {
    console.error('Error during CSV analysis:', error);
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'India.csv file not found.' });
    } else if (error.message.includes('token count exceeds')) {
      res.status(400).json({ error: 'Input too large for model. Try a smaller CSV or increase sampling limit.' });
    } else if (error.status === 400 && error.message.includes('response_schema')) {
      res.status(400).json({ error: 'Schema validation failed—check config.', details: error.message });
    } else {
      res.status(500).json({ error: 'Failed to process CSV file with Gemini API.', details: error.message });
    }
  }
});

// Basic welcome route
app.get('/', (req, res) => {
  res.send('<h1>Gemini API Demo</h1><p>Visit <a href="/gemini">/gemini</a> for a quick chat or <a href="/analyze-india-csv">/analyze-india-csv</a> to get the analysis.</p>');
});

export default app;