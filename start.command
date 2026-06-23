#!/bin/bash
# Move to the directory where this script is located
cd "$(dirname "$0")"

echo "================================================="
echo "   Starting Human Typer Simulator Web GUI...   "
echo "================================================="
echo ""

# Launch the human_typer.py script
python3 human_typer.py

# Keep the window open in case it exits immediately
echo ""
echo "Press enter to exit."
read
