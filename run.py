"""
Wrapper script around fetch.py

This is necessary because LD_LIBRARY_PATH needs to be set appropriately before
the Python process starts, so a wrapper script to set environment variables is
necessary.
"""

import os
import subprocess
import sys

from dotenv import load_dotenv

load_dotenv()

oracle_home = os.environ.get("ORACLE_HOME")
if oracle_home is not None:
    # Add $ORACLE_HOME to $LD_LIBRARY_PATH
    ld_library_path = os.environ.get("LD_LIBRARY_PATH")
    if ld_library_path is not None:
        os.environ["LD_LIBRARY_PATH"] = f"{oracle_home}:{ld_library_path}"
    else:
        os.environ["LD_LIBRARY_PATH"] = oracle_home

script_path = os.path.relpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "fetch.py")
)

# Run script with the arguments we were given
subprocess.run([sys.executable, script_path, *sys.argv[1:]], env=os.environ)
