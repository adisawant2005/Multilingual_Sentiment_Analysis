# Gemini-Powered CSV Data Analyzer and Translator 📊

This project is a Node.js Express server that utilizes the **Google Gemini API (specifically `gemini-2.5-flash`)** for advanced data analysis and natural language processing on a local CSV file (`India.csv`).

It demonstrates how to leverage Gemini's structured output capabilities (JSON Schema) to reliably extract statistics, trends, and sentiment counts from raw data, and even translate the insights into different languages.

---

## ✨ Features

* **Structured CSV Analysis:** Analyzes a sampled portion of `India.csv` and returns a detailed summary, statistics, trends, and insights, strictly conforming to a defined JSON schema (`ANALYSIS_SCHEMA`).
* **Sentiment Counting:** Calculates the positive, negative, and neutral sentiment distribution within the text columns of the CSV data, returning structured JSON results (`SENTIMENT_SCHEMA`).
* **Multilingual Analysis:** The `/analyze-india-csv-translate` endpoint performs the analysis and then translates the resulting summary and insights into any specified target language.
* **Robust Data Handling:** Includes token estimation and size limits to prevent exceeding model context windows.

---

## 🛠️ Setup and Installation

### Prerequisites

* Node.js (LTS recommended)
* A Gemini API Key (available from Google AI Studio)
* A local CSV file named **`India.csv`** in the project root directory.

### Step 1: Clone the Repository

```bash
git clone <repository-url>
cd <project-folder>