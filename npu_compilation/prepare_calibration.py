import os
import urllib.request

def main():
    print("=== Preparando Dataset de Calibração para Quantização INT8 ===")
    
    # Pasta para salvar imagens temporárias de calibração
    img_dir = "./calibration_images"
    os.makedirs(img_dir, exist_ok=True)
    
    # URL de imagens de exemplo de pessoas (COCO dataset)
    urls = [
        "http://images.cocodataset.org/val2017/000000000139.jpg",
        "http://images.cocodataset.org/val2017/000000000285.jpg",
        "http://images.cocodataset.org/val2017/000000000632.jpg",
        "http://images.cocodataset.org/val2017/000000000724.jpg",
        "http://images.cocodataset.org/val2017/000000000776.jpg"
    ]
    
    dataset_file = "calibrate_dataset.txt"
    with open(dataset_file, "w", encoding="utf-8") as f:
        for i, url in enumerate(urls):
            img_path = os.path.abspath(os.path.join(img_dir, f"person_{i}.jpg"))
            print(f"Baixando imagem de calibração {i+1}/5...")
            try:
                urllib.request.urlretrieve(url, img_path)
                f.write(f"{img_path}\n")
            except Exception as e:
                print(f"Erro ao baixar imagem {url}: {e}")
                
    print(f"\n[OK] Arquivo {dataset_file} gerado com sucesso!")
    print("Execute agora o script 'acuity_export_yolo.sh' dentro do Docker Acuity.")

if __name__ == '__main__':
    main()
