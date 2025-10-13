import express from 'express';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import csvParser from 'csv-parser';

dotenv.config();

const app = express();
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Function to parse CSV file
async function parseCsv(filePath, maxRows = 1000) {
  if (!fs.existsSync(filePath)) {
    throw new Error('CSV file not found.');
  }

  const rows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (row) => rows.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  if (rows.length === 0) {
    throw new Error('CSV file is empty.');
  }

  const sampleRows = rows.slice(0, maxRows);
  return { rows, sampleRows };
}

// Function to estimate tokens
function estimateTokens(compactCsv) {
  return Math.ceil(compactCsv.length / 4) + 500;
}

// Function to handle errors
function handleError(res, error) {
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

// Define schema for analysis endpoint
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Short overall summary of key findings from the data.',
    },
    statistics: {
      type: 'object',
      properties: {
        total_rows: {
          type: 'number',
          description: 'Total number of rows in the dataset.',
        },
        avg_value: {
          type: 'number',
          description: 'Average value of a key numeric column in the sample.',
        },
        top_columns: {
          type: 'array',
          items: {
            type: 'string',
            description: 'Top columns with highest values.',
          },
        },
        top_values: {
          type: 'array',
          items: {
            type: 'string',
            description: 'Top values in the dataset.',
          },
        },
        most_active: {
          type: 'array',
          items: {
            type: 'string',
            description: 'Most active entities (e.g., users, categories).',
          },
        },
      },
      description: 'Metrics like averages or totals for relevant columns from the sample.',
      additionalProperties: true,
    },
    trend_analysis: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          column: {
            type: 'string',
            description: 'Column name.',
          },
          trend: {
            type: 'string',
            description: 'Trend direction (increasing/decreasing).',
          },
          value: {
            type: 'number',
            description: 'Value associated with the trend.',
          },
        },
      },
    },
    insights: {
      type: 'array',
      items: {
        type: 'string',
        description: 'Notable trends or observations.',
      },
    },
  },
  required: ['summary', 'statistics', 'trend_analysis', 'insights'],
  additionalProperties: false,
};

// Define schema for sentiment counting endpoint
const SENTIMENT_SCHEMA = {
  type: 'object',
  properties: {
    positive: {
      type: 'number',
      description: 'Number of positive tweets.',
    },
    negative: {
      type: 'number',
      description: 'Number of negative tweets.',
    },
    neutral: {
      type: 'number',
      description: 'Number of neutral tweets.',
    },
    positive_percent: {
      type: 'number',
      description: 'Percentage of positive tweets.',
    },
    negative_percent: {
      type: 'number',
      description: 'Percentage of negative tweets.',
    },
    neutral_percent: {
      type: 'number',
      description: 'Percentage of neutral tweets.',
    },
  },
  required: ['positive', 'negative', 'neutral', 'positive_percent', 'negative_percent', 'neutral_percent'],
  additionalProperties: false,
};

// Route for general chat
app.get('/gemini', async (req, res) => {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          parts: [{ text: 'How are you' }],
        },
      ],
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
    const csvFilePath = './India.csv';
    const { rows, sampleRows } = await parseCsv(csvFilePath, 100);

    const headers = Object.keys(sampleRows[0] || {});
    let compactCsv = `Headers: ${headers.join(',')}\n\nSample Data (${sampleRows.length} of ${rows.length} rows sampled for analysis):\n`;
    sampleRows.forEach((row) => {
      compactCsv += `${Object.values(row).map((val) => `"${val}"`).join(',')}\n`;
    });
    compactCsv += `\n\nFull dataset has ${rows.length} rows. Extrapolate trends from this sample.`;

    const estimatedTokens = estimateTokens(compactCsv);
    const MAX_TOKENS = 2000000; // Gemini 2.5 limit
    if (estimatedTokens > MAX_TOKENS) {
      return res.status(400).json({
        error: `CSV too large (${estimatedTokens} estimated tokens). Sample only ${Math.floor((MAX_TOKENS * 4) / Object.keys(sampleRows[0]).length / 10)} rows or use a smaller file.`,
      });
    }

    console.log(`Using ${sampleRows.length} rows; estimated tokens: ${estimatedTokens}`);

    const prompt = [
      {
        parts: [
          {
            text: `Here is sampled data from India.csv (full dataset has ${rows.length} rows):

${compactCsv}

Analyze this data and return the result STRICTLY in the following JSON format — no extra text, no markdown.

JSON Schema:

{
  "summary": "Short overall summary of key findings from the data.",
  "statistics": {
    "total_rows": ${rows.length},
    "avg_value": 0.0,
    "top_columns": ["column1", "column2"],
    "top_values": ["value1", "value2"],
    "most_active": ["entity1", "entity2"]
  },
  "trend_analysis": [
    {
      "column": "column1",
      "trend": "increasing/decreasing",
      "value": 0.0
    }
  ],
  "insights": [
    "Insight 1: Notable trend or observation.",
    "Insight 2: Any shift in data or unusual pattern."
  ]
}

Features Included:

* Basic statistics (total rows, average value)
* Top columns and values
* Trend analysis of key columns
* Insights into notable trends or observations

Return the analysis in the specified JSON format.`,
          },
        ],
      },
    ];

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: ANALYSIS_SCHEMA,
        thinkingBudget: 0,
        temperature: 0, // Max consistency
      },
    });

    const responseText = result.text;
    console.log('Raw response from Gemini:', responseText); // Debug log

    if (!responseText) {
      return res.status(500).json({
        error: 'Gemini returned empty response.',
        result: JSON.stringify(result, null, 2),
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
        parseError: parseError.message,
      });
    }

    analysis.metadata = { fullRows: rows.length, sampledRows: sampleRows.length, estimatedTokens };
    res.json(analysis);
  } catch (error) {
    handleError(res, error);
  }
});

// Define a route to trigger the sentiment counting of the local CSV file
app.get('/count-sentiment-india-csv', async (req, res) => {
  try {
    const csvFilePath = './India.csv';
    const { rows, sampleRows } = await parseCsv(csvFilePath, 100);

    const prompt = [
      {
        parts: [
          {
            text: `Here is sampled data from India.csv (full dataset has ${rows.length} rows):

${sampleRows.map((row) => Object.values(row).join(',')).join('\n')}

Count the number of positive, negative, and neutral tweets in the dataset and return the result in the following JSON format:

{
  "positive": 0,
  "negative": 0,
  "neutral": 0,
  "positive_percent": 0.0,
  "negative_percent": 0.0,
  "neutral_percent": 0.0
}`,
          },
        ],
      },
    ];

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            positive: {
              type: 'number',
              description: 'Number of positive tweets.',
            },
            negative: {
              type: 'number',
              description: 'Number of negative tweets.',
            },
            neutral: {
              type: 'number',
              description: 'Number of neutral tweets.',
            },
            positive_percent: {
              type: 'number',
              description: 'Percentage of positive tweets.',
            },
            negative_percent: {
              type: 'number',
              description: 'Percentage of negative tweets.',
            },
            neutral_percent: {
              type: 'number',
              description: 'Percentage of neutral tweets.',
            },
          },
          required: ['positive', 'negative', 'neutral', 'positive_percent', 'negative_percent', 'neutral_percent'],
          additionalProperties: false,
        },
      },
    });

    const responseText = result.text;
    console.log('Raw response from Gemini:', responseText); // Debug log

    if (!responseText) {
      return res.status(500).json({
        error: 'Gemini returned empty response.',
        result: JSON.stringify(result, null, 2),
      });
    }

    let sentimentCounts;
    try {
      sentimentCounts = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse JSON response:', responseText);
      return res.status(500).json({
        error: 'Gemini returned invalid JSON format.',
        geminiResponse: responseText,
        parseError: parseError.message,
      });
    }

    res.json(sentimentCounts);
  } catch (error) {
    handleError(res, error);
  }
});

// Function to translate text using Gemini
async function translateText(text, targetLanguage) {
  if (!text || text.length === 0) {
    return text;
  }

  const prompt = `Translate the following text into ${targetLanguage}. Return ONLY the translated text, with no introductory phrases, explanations, or markdown formatting.

Text to translate:
---
${text}
---`;

  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      temperature: 0.1, // Keep it focused on translation
    },
  });

  return result.text.trim();
}

// Define the new route to analyze and translate
app.get('/analyze-india-csv-translate', async (req, res) => {
  const { lang = 'French' } = req.query; // Default to French if no 'lang' query param is provided
  const targetLanguage = lang.trim();

  try {
    // 1. Call the existing /analyze-india-csv logic internally
    // We need to duplicate the core analysis logic since we cannot make an internal HTTP call easily.
    const csvFilePath = './India.csv';
    const { rows, sampleRows } = await parseCsv(csvFilePath, 100);

    const headers = Object.keys(sampleRows[0] || {});
    let compactCsv = `Headers: ${headers.join(',')}\n\nSample Data (${sampleRows.length} of ${rows.length} rows sampled for analysis):\n`;
    sampleRows.forEach((row) => {
      compactCsv += `${Object.values(row).map((val) => `"${val.toString().replace(/"/g, '""')}"`).join(',')}\n`;
    });
    compactCsv += `\n\nFull dataset has ${rows.length} rows. Analyze the sample and extrapolate.`;

    const estimatedTokens = estimateTokens(compactCsv);
    const MAX_TOKENS = 2000000;
    if (estimatedTokens > MAX_TOKENS) {
      return res.status(400).json({
        error: 'Input too large for model for analysis.',
      });
    }

    const analysisPromptText = `
Here is sampled data from India.csv (full dataset has ${rows.length} rows):
${compactCsv}
Analyze this data and return the result STRICTLY in the specified JSON format. Ensure all sections (summary, statistics, trend_analysis, insights) are fully populated.
`;

    const analysisResult = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ parts: [{ text: analysisPromptText }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: ANALYSIS_SCHEMA,
        temperature: 0,
      },
    });

    const responseText = analysisResult.text;
    if (!responseText) {
      return res.status(500).json({ error: 'Gemini returned empty response for analysis.' });
    }

    let analysis;
    try {
      analysis = JSON.parse(responseText);
      if (analysis.statistics) {
        analysis.statistics.total_rows = rows.length;
      }
    } catch (parseError) {
      console.error('Failed to parse analysis JSON:', responseText);
      return res.status(500).json({ error: 'Analysis returned invalid JSON.' });
    }
    analysis.metadata = { ...analysis.metadata, fullRows: rows.length, sampledRows: sampleRows.length, estimatedTokens };
    
    // 2. Translate the Summary
    const originalSummary = analysis.summary || '';
    const translatedSummary = await translateText(originalSummary, targetLanguage);
    analysis.summary = translatedSummary;

    // 3. Translate the Insights array
    const originalInsights = analysis.insights || [];
    const translatedInsights = [];

    for (const insight of originalInsights) {
      const translatedInsight = await translateText(insight, targetLanguage);
      translatedInsights.push(translatedInsight);
    }

    analysis.insights = translatedInsights;

    // 4. Final response
    res.json({
      target_language: targetLanguage,
      analysis_translated: analysis,
    });

  } catch (error) {
    handleError(res, error);
  }
});

// Update the welcome route to include the new endpoint
app.get('/', (req, res) => {
  res.send('<h1>Gemini API Demo</h1><p>Visit <a href="/gemini">/gemini</a> for a quick chat or <a href="/analyze-india-csv">/analyze-india-csv</a> to get the analysis or <a href="/count-sentiment-india-csv">/count-sentiment-india-csv</a> to get the sentiment counts. New: <a href="/analyze-india-csv-translate?lang=Spanish">/analyze-india-csv-translate?lang=Spanish</a> to analyze and translate.</p>');
});

export default app;